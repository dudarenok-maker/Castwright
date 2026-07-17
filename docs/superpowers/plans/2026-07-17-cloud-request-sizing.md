# Cloud Request Sizing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Size every cloud (Gemini/Gemma) analyzer request to the free-tier's per-minute input-token limit, pace requests, classify a per-minute 429 as retryable (not fatal daily-quota), and guarantee the rate limiter never hangs.

**Architecture:** A new shared `token-budget.ts` converts a per-request token cap into a script-aware char budget, reused by all three cloud sizing seams (stage-1, stage-2, output-heavy). The Gemma rate-limiter gets a finite free-tier TPM plus a fail-fast guard so an over-cap estimate errors instead of spinning. The daily-quota classifier is narrowed to genuine `per_day` markers at all three sites.

**Tech Stack:** TypeScript (Node ESM), Vitest (node env), the repo's config registry (`server/src/config/registry.ts` + `npm run config:sync`).

## Global Constraints

- Node ESM; imports use `.js` extensions. Server tests: `cd server && npm run test -- <file>` (or `npm run test:server`).
- OpenAPI/config are generated: any `registry.ts` change REQUIRES `npm run config:sync` in the same commit (validated by `config:check`).
- **Every new env var MUST be a registry knob (Advanced Settings).** No setting may be read from `process.env` without a corresponding `registry.ts` entry surfacing it as a knob. Each of this plan's four new env vars maps to a registry key (table below); do not add any env-only read. Add each to `server/.env.example` too (documentation surface), commented at its default.
  - `ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST` → `analyzer.gemini.maxInputTokensPerRequest`
  - `ANALYZER_STAGE1_LOCAL_INPUT_FRACTION` → `analyzer.stage1.localInputFraction`
  - `ANALYZER_STAGE2_LOCAL_INPUT_FRACTION` → `analyzer.stage2.localInputFraction`
  - `GEMINI_TPM_GEMMA_4_26B_A4B_IT` → `rate.tpm.gemma26`
- RTK/immer conventions are frontend-only; this is all server-side.
- Commit convention: `<type>(<scope>): <subject>`; scope `server` for code, `docs` for docs. End every commit body with the two trailer lines used on this branch.
- Free-tier reality: Gemma input limit is **16,000 tokens/minute** (`quotaId: …PerMinute-FreeTier`). Per-request body cap default **12000**.
- The density ratio is **not measured** (the 429 carries no `promptTokenCount`); size conservatively and rely on the fail-fast guard, never on a precise chars/token.
- Branch is already cut: `fix/server-cloud-request-sizing`. Worktree: `.claude/worktrees/cloud-request-sizing` (node_modules junctioned).

---

## File structure

- **Create** `server/src/analyzer/token-budget.ts` — script-aware char↔token conversion + cloud char-budget helper + `maxInputTokensPerRequest` resolver. Single responsibility: token budgeting.
- **Create** `server/src/analyzer/token-budget.test.ts`.
- **Modify** `server/src/analyzer/gemini.ts` — `estimateInputTokens` reuses `token-budget.ts`; 429 daily-quota regex narrowed.
- **Modify** `server/src/analyzer/stage1-chunk.ts`, `stage2-chunk.ts` — cloud branches size to the token cap; local branches read the input-fraction knobs.
- **Modify** `server/src/analyzer/chapter-chunker.ts` + `routes/{script-review,annotate-emotion,instruct-annotation}.ts` — output-heavy cloud sizing with roster/context reservation.
- **Modify** `server/src/analyzer/rate-limit.ts` — Gemma TPM finite, `0`/`unlimited` sentinel, fail-fast guard, `RequestExceedsTpmError`.
- **Modify** `server/src/routes/failure-taxonomy.ts` — narrow both daily-quota matchers; classify `RequestExceedsTpmError`.
- **Modify** `server/src/config/registry.ts` (+ `npm run config:sync`) — new knobs.
- **Modify** `docs/features/archive/06-analyzer-gemini.md`, `docs/release-notes-next.md`, `RELEASE_NOTES.md`.

---

## Task 1: Shared token-budget module + per-request cap knob

**Files:**
- Create: `server/src/analyzer/token-budget.ts`
- Create: `server/src/analyzer/token-budget.test.ts`
- Modify: `server/src/analyzer/gemini.ts:881-931` (refactor `estimateInputTokens` to reuse; move the script constants + `countCyrillic`)
- Modify: `server/src/config/registry.ts` (add `analyzer.gemini.maxInputTokensPerRequest`)

**Interfaces:**
- Produces:
  - `charsPerTokenForText(text: string): number` — interpolated chars/token (Latin 4 … Cyrillic 2.5 … CJK 1.2).
  - `resolveMaxInputTokensPerRequest(): number` — reads `analyzer.gemini.maxInputTokensPerRequest`.
  - `cloudBodyCharBudget(body: string, reservedChars?: number): number` — `max(2000, floor(maxTokens × charsPerTokenForText(body)) − reservedChars)`.
  - Re-exports `LATIN_CHARS_PER_TOKEN`, `CYRILLIC_CHARS_PER_TOKEN`, `HAN_KANA_CHARS_PER_TOKEN`, `countCyrillic`.

- [ ] **Step 1: Write the failing test** — `server/src/analyzer/token-budget.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { charsPerTokenForText, cloudBodyCharBudget, resolveMaxInputTokensPerRequest } from './token-budget.js';

describe('charsPerTokenForText', () => {
  it('returns ~4 for all-Latin text', () => {
    expect(charsPerTokenForText('The quick brown fox jumps')).toBeCloseTo(4, 5);
  });
  it('returns ~2.5 for all-Cyrillic text', () => {
    expect(charsPerTokenForText('Антон Городецкий шёл домой')).toBeLessThan(2.7);
    expect(charsPerTokenForText('Антон Городецкий шёл домой')).toBeGreaterThan(2.3);
  });
  it('defaults to Latin for empty text', () => {
    expect(charsPerTokenForText('')).toBe(4);
  });
});

describe('cloudBodyCharBudget', () => {
  it('sizes a Cyrillic body to fewer chars than an equal token cap of Latin', () => {
    const ru = 'а'.repeat(1000);
    const en = 'a'.repeat(1000);
    expect(cloudBodyCharBudget(ru)).toBeLessThan(cloudBodyCharBudget(en));
  });
  it('subtracts reserved chars (roster overhead)', () => {
    const body = 'a'.repeat(1000);
    expect(cloudBodyCharBudget(body, 5000)).toBe(cloudBodyCharBudget(body, 0) - 5000);
  });
  it('never drops below the 2000 floor', () => {
    expect(cloudBodyCharBudget('a'.repeat(10), 10_000_000)).toBe(2000);
  });
});

describe('resolveMaxInputTokensPerRequest', () => {
  it('defaults to 12000', () => {
    expect(resolveMaxInputTokensPerRequest()).toBe(12000);
  });
});
```

- [ ] **Step 2: Run it, verify failure**

Run: `cd server && npm run test -- src/analyzer/token-budget.test.ts`
Expected: FAIL — `Cannot find module './token-budget.js'`.

- [ ] **Step 3: Create `server/src/analyzer/token-budget.ts`**

```ts
/* Script-aware token budgeting shared by the estimator (gemini.ts) and the
   cloud chunk sizers (stage1/2-chunk, chapter-chunker). The 429 that motivated
   this carries no promptTokenCount, so the ratio is a bounded approximation, not
   a measurement — size conservatively; the rate-limiter fail-fast guard backstops. */
import { configValue } from '../config/resolver.js';
import { countCjkChars } from './cjk.js'; // ← same import gemini.ts uses today

export const LATIN_CHARS_PER_TOKEN = 4;
export const CYRILLIC_CHARS_PER_TOKEN = 2.5;
export const HAN_KANA_CHARS_PER_TOKEN = 1.2;

export function countCyrillic(s: string): number {
  const m = s.match(/[Ѐ-ӿ]/g);
  return m ? m.length : 0;
}

/** Interpolated chars-per-token for `text` from its Cyrillic / CJK fraction. */
export function charsPerTokenForText(text: string): number {
  const chars = text.length;
  if (chars === 0) return LATIN_CHARS_PER_TOKEN;
  const cyr = countCyrillic(text) / chars;
  const han = countCjkChars(text) / chars;
  return (
    LATIN_CHARS_PER_TOKEN -
    cyr * (LATIN_CHARS_PER_TOKEN - CYRILLIC_CHARS_PER_TOKEN) -
    han * (LATIN_CHARS_PER_TOKEN - HAN_KANA_CHARS_PER_TOKEN)
  );
}

export function resolveMaxInputTokensPerRequest(): number {
  return configValue<number>('analyzer.gemini.maxInputTokensPerRequest');
}

/** Char budget for a cloud request body sized to the per-request token cap,
    minus fixed per-call overhead (roster/context/system). 2000-char floor. */
export function cloudBodyCharBudget(body: string, reservedChars = 0): number {
  const perRequestChars = Math.floor(resolveMaxInputTokensPerRequest() * charsPerTokenForText(body));
  return Math.max(2000, perRequestChars - reservedChars);
}
```

> NOTE: confirm the CJK counter import path — in `gemini.ts` today `countCjkChars` is imported from a sibling module; reuse that exact path here (grep `import.*countCjkChars` in `server/src/analyzer/`).

- [ ] **Step 4: Add the registry knob** — `server/src/config/registry.ts`, in the `analyzer-sampling` group next to `analyzer.gemini.maxOutputTokens`:

```ts
  {
    key: 'analyzer.gemini.maxInputTokensPerRequest',
    env: 'ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST',
    group: 'analyzer-sampling',
    label: 'Gemini max input tokens per request',
    help: 'Per-request INPUT-token cap for cloud analyzer passes (stage-1, stage-2, script-review/emotion/instruct). Body chunks are sized to this; must stay below the model TPM (Gemma free tier = 16000/min) so the system prompt + roster fit. Default 12000.',
    type: 'integer', min: 1000, max: 60000,
    default: 12000,
    apply: 'live', risk: 'medium',
  },
```

- [ ] **Step 5: Run `config:sync`, verify token-budget tests pass**

Run: `cd server && npm run config:sync && npm run test -- src/analyzer/token-budget.test.ts`
Expected: config files regenerate; all token-budget tests PASS.

- [ ] **Step 6: Refactor `estimateInputTokens` to reuse the shared constants (keep it green)**

In `gemini.ts`: delete the local `LATIN_CHARS_PER_TOKEN` / `CYRILLIC_CHARS_PER_TOKEN` / `HAN_KANA_CHARS_PER_TOKEN` constants (`:900-902`) and the inline `countCyrillic` closure (`:911-914`); import them from `./token-budget.js`:

```ts
import {
  LATIN_CHARS_PER_TOKEN,
  CYRILLIC_CHARS_PER_TOKEN,
  HAN_KANA_CHARS_PER_TOKEN,
  countCyrillic,
} from './token-budget.js';
```

Leave the body of `estimateInputTokens` — its char/fraction counting and the divisor line (`:926-929`) — **numerically unchanged**; it now references the imported constants and `countCyrillic`. This is a pure de-duplication: the existing `gemini.test.ts` token-estimate tests must stay green (no numeric drift). Do NOT route `estimateInputTokens` through `charsPerTokenForText` (that would require concatenating all turns; keep the existing per-turn summation).

- [ ] **Step 7: Run gemini estimator tests**

Run: `cd server && npm run test -- src/analyzer/gemini.test.ts`
Expected: PASS (no numeric drift).

- [ ] **Step 8: Commit**

```bash
git add server/src/analyzer/token-budget.ts server/src/analyzer/token-budget.test.ts server/src/analyzer/gemini.ts server/src/config/registry.ts server/src/config/generated*
git commit -m "feat(server): shared token-budget helper + per-request input cap knob (#1682)"
```

---

## Task 2: Stage-1 cloud sizing + local input-fraction knob

**Files:**
- Modify: `server/src/analyzer/stage1-chunk.ts:48-68`
- Modify: `server/src/config/registry.ts` (add `analyzer.stage1.localInputFraction`)
- Test: `server/src/analyzer/stage1-chunk.test.ts`

**Interfaces:**
- Consumes: `cloudBodyCharBudget` (Task 1).
- Produces: `stage1ChunkBudgetForEngine(configured, numCtxTokens, engine, body?)` now returns a finite cloud budget.

- [ ] **Step 1: Write failing tests** — append to `stage1-chunk.test.ts`:

```ts
import { resolveStage1ChunkCharBudget, stage1ChunkBudgetForEngine } from './stage1-chunk.js';

it('cloud stage-1 sizes to the token cap, not MAX_SAFE_INTEGER', () => {
  const ruBody = 'а'.repeat(60000);
  const budget = resolveStage1ChunkCharBudget('gemini', ruBody);
  expect(budget).toBeLessThan(60000);
  expect(budget).toBeGreaterThan(2000);
});

it('local stage-1 input fraction knob lowers the budget', () => {
  // default 0.7; a smaller fraction → smaller budget (verify via stage1ChunkBudgetForEngine)
  const hi = stage1ChunkBudgetForEngine(24000, 32768, 'local', 0.7);
  const lo = stage1ChunkBudgetForEngine(24000, 32768, 'local', 0.4);
  expect(lo).toBeLessThan(hi);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd server && npm run test -- src/analyzer/stage1-chunk.test.ts`
Expected: FAIL — `resolveStage1ChunkCharBudget('gemini', body)` still returns `MAX_SAFE_INTEGER` / arity mismatch.

- [ ] **Step 3: Implement** — replace `stage1ChunkBudgetForEngine` and `resolveStage1ChunkCharBudget` (`stage1-chunk.ts:48-68`):

```ts
import { cloudBodyCharBudget } from './token-budget.js';

export function stage1ChunkBudgetForEngine(
  configured: number,
  numCtxTokens: number,
  engine: 'gemini' | 'local',
  localInputFraction: number,
): number {
  if (engine !== 'local') return configured; // cloud: caller passes the token-derived budget in `configured`
  const numCtxDerived = Math.floor(numCtxTokens * localInputFraction * 2);
  return Math.max(2000, Math.min(configured, numCtxDerived));
}

export function resolveStage1ChunkCharBudget(engine?: 'gemini' | 'local', body?: string): number {
  if (engine !== 'local') {
    // Cloud: size to the per-request token cap (was MAX_SAFE_INTEGER = never chunk).
    return cloudBodyCharBudget(body ?? '');
  }
  return stage1ChunkBudgetForEngine(
    configValue<number>('analyzer.stage1.chunkCharBudget'),
    configValue<number>('analyzer.ollama.numCtx'),
    'local',
    configValue<number>('analyzer.stage1.localInputFraction'),
  );
}
```

> The stage-1 CALLER (`routes/analysis.ts`, where `resolveStage1ChunkCharBudget(engine)` is invoked) must now pass the chapter body: `resolveStage1ChunkCharBudget(engine, chapterBody)`. Grep `resolveStage1ChunkCharBudget(` and update each call to pass the body it is about to chunk. `chapter-chunker.ts:102` calls `resolveStage1ChunkCharBudget('local')` — local ignores `body`, so that call is unaffected.

- [ ] **Step 4: Add the registry knob**

```ts
  {
    key: 'analyzer.stage1.localInputFraction',
    env: 'ANALYZER_STAGE1_LOCAL_INPUT_FRACTION',
    group: 'analyzer-chunking',
    label: 'Stage-1 local input fraction',
    help: 'Fraction of local num_ctx reserved for stage-1 INPUT (rest is prompt+output). Lower it for a verbose local model that overflows the window. Default 0.7.',
    type: 'number', min: 0.1, max: 0.9, step: 0.05,
    default: 0.7,
    apply: 'live', risk: 'medium',
  },
```

- [ ] **Step 5: `config:sync`, run tests**

Run: `cd server && npm run config:sync && npm run test -- src/analyzer/stage1-chunk.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/stage1-chunk.ts server/src/analyzer/stage1-chunk.test.ts server/src/routes/analysis.ts server/src/config/registry.ts server/src/config/generated*
git commit -m "feat(server): size cloud stage-1 to the token cap + local input-fraction knob (#1682)"
```

---

## Task 3: Stage-2 cloud sizing + local input-fraction knob

**Files:**
- Modify: `server/src/analyzer/stage2-chunk.ts:47-76`
- Modify: `server/src/config/registry.ts` (add `analyzer.stage2.localInputFraction`)
- Test: `server/src/analyzer/stage2-chunk.test.ts`

**Interfaces:**
- Consumes: `cloudBodyCharBudget` (Task 1).
- Produces: `resolveStage2ChunkCharBudget(engine?, body?)` returns `min(configured, token-derived)` for cloud.

- [ ] **Step 1: Write failing tests** — append to `stage2-chunk.test.ts`:

```ts
import { resolveStage2ChunkCharBudget, stage2ChunkBudgetForEngine } from './stage2-chunk.js';

it('cloud stage-2 caps to min(configured, token-derived)', () => {
  const ruBody = 'а'.repeat(60000);
  const budget = resolveStage2ChunkCharBudget('gemini', ruBody);
  expect(budget).toBeLessThanOrEqual(9000); // configured default
  expect(budget).toBeGreaterThan(0);
});

it('local stage-2 input fraction knob lowers the budget', () => {
  const hi = stage2ChunkBudgetForEngine(9000, 32768, 'local', 0.3);
  const lo = stage2ChunkBudgetForEngine(9000, 32768, 'local', 0.15);
  expect(lo).toBeLessThan(hi);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd server && npm run test -- src/analyzer/stage2-chunk.test.ts`
Expected: FAIL (arity / cloud returns full configured unconditionally).

- [ ] **Step 3: Implement** — replace `stage2ChunkBudgetForEngine` + `resolveStage2ChunkCharBudget` (`stage2-chunk.ts:58-76`):

```ts
import { cloudBodyCharBudget } from './token-budget.js';

export function stage2ChunkBudgetForEngine(
  configured: number,
  numCtxTokens: number,
  engine: 'gemini' | 'local',
  localInputFraction: number,
): number {
  if (engine !== 'local') return configured;
  const numCtxDerived = Math.floor(numCtxTokens * 2 * localInputFraction);
  return Math.max(1000, Math.min(configured, numCtxDerived));
}

export function resolveStage2ChunkCharBudget(engine?: 'gemini' | 'local', body?: string): number {
  const configured = configValue<number>('analyzer.stage2.chunkCharBudget');
  if (engine !== 'local') {
    // Cloud: min(configured, token-cap-derived).
    return Math.min(configured, cloudBodyCharBudget(body ?? ''));
  }
  return stage2ChunkBudgetForEngine(
    configured,
    configValue<number>('analyzer.ollama.numCtx'),
    'local',
    configValue<number>('analyzer.stage2.localInputFraction'),
  );
}
```

> Update the stage-2 caller in `routes/analysis.ts` to pass the chapter body: `resolveStage2ChunkCharBudget(engine, chapterBody)`. Grep `resolveStage2ChunkCharBudget(`.

- [ ] **Step 4: Add the registry knob**

```ts
  {
    key: 'analyzer.stage2.localInputFraction',
    env: 'ANALYZER_STAGE2_LOCAL_INPUT_FRACTION',
    group: 'analyzer-chunking',
    label: 'Stage-2 local input fraction',
    help: 'Fraction of local num_ctx reserved for stage-2 INPUT (rest is output — per-sentence JSON, which scales with section size). Lower it for a verbose local model whose output overflows the window (qwen3.5:4b / gemma4-e4b). Default 0.3.',
    type: 'number', min: 0.1, max: 0.9, step: 0.05,
    default: 0.3,
    apply: 'live', risk: 'medium',
  },
```

- [ ] **Step 5: `config:sync`, run tests**

Run: `cd server && npm run config:sync && npm run test -- src/analyzer/stage2-chunk.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/stage2-chunk.ts server/src/analyzer/stage2-chunk.test.ts server/src/routes/analysis.ts server/src/config/registry.ts server/src/config/generated*
git commit -m "feat(server): size cloud stage-2 to the token cap + local input-fraction knob (#1682)"
```

---

## Task 4: Output-heavy cloud sizing (script-review / emotion / instruct)

**Files:**
- Modify: `server/src/analyzer/chapter-chunker.ts:101-104`
- Modify: `server/src/routes/script-review.ts:795`, `annotate-emotion.ts:166`, `instruct-annotation.ts` (the `chapterChunkBudget(engine)` call)
- Test: `server/src/analyzer/chapter-chunker.test.ts`

**Interfaces:**
- Consumes: `cloudBodyCharBudget` (Task 1).
- Produces: `chapterChunkBudget(engine, reservedChars?, sampleText?)` — gemini returns `min(outputHeavyChunkChars, cloudBodyCharBudget(sampleText, reservedChars))`.

- [ ] **Step 1: Write failing test** — append to `chapter-chunker.test.ts`:

```ts
it('gemini output-heavy budget shrinks as reserved (roster) chars grow', () => {
  const sample = 'а'.repeat(5000);
  const noRoster = chapterChunkBudget('gemini', 0, sample);
  const bigRoster = chapterChunkBudget('gemini', 14000, sample);
  expect(bigRoster).toBeLessThan(noRoster);
});

it('gemini output-heavy budget never exceeds outputHeavyChunkChars', () => {
  const sample = 'a'.repeat(5000);
  expect(chapterChunkBudget('gemini', 0, sample)).toBeLessThanOrEqual(32000);
});

it('local output-heavy budget is unchanged (num_ctx-derived, roster ignored)', () => {
  expect(chapterChunkBudget('local', 14000, 'x')).toBe(resolveStage1ChunkCharBudget('local'));
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd server && npm run test -- src/analyzer/chapter-chunker.test.ts`
Expected: FAIL (arity mismatch; gemini ignores reservedChars).

- [ ] **Step 3: Implement** — `chapter-chunker.ts:101-104`:

```ts
import { cloudBodyCharBudget } from './token-budget.js';

export function chapterChunkBudget(
  engine: 'gemini' | 'local',
  reservedChars = 0,
  sampleText = '',
): number {
  if (engine === 'local') return resolveStage1ChunkCharBudget('local'); // roster rides on num_ctx; local truncation is the stage-2 fraction knob's domain
  const outputCap = configValue<number>('analyzer.gemini.outputHeavyChunkChars');
  return Math.min(outputCap, cloudBodyCharBudget(sampleText, reservedChars));
}
```

- [ ] **Step 4: Update the three call sites to pass roster + sample**

In each route, the roster is serialized into the prompt; compute its length once and pass it. Pattern (adapt variable names per route):

`script-review.ts:795` — the roster is `roster` (`CastCharacterSlim[]`); the sentences being chunked are `sentences`. Replace:

```ts
        charBudget: chapterChunkBudget(activeSelection.engine),
```

with:

```ts
        charBudget: chapterChunkBudget(
          activeSelection.engine,
          JSON.stringify(roster).length + 800, // roster payload + fixed template scaffold
          sentences.map((s) => s.text).join(' '), // script sample → chars/token
        ),
```

Apply the equivalent at `annotate-emotion.ts:166` and `instruct-annotation.ts` (each has a `roster`/`CastCharacterSlim[]` in scope and a `sentences` array; use the same two extra args). The `+800` is a conservative fixed allowance for the prompt header/instructions — keep it identical across the three so behavior is uniform.

- [ ] **Step 5: `config:sync` not needed (no new knob); run tests**

Run: `cd server && npm run test -- src/analyzer/chapter-chunker.test.ts src/routes/script-review.test.ts src/routes/annotate-emotion.test.ts src/routes/instruct-annotation.test.ts`
Expected: PASS. (If a route test asserted the old one-call-per-chapter behavior for gemini on a large Cyrillic chapter, update it to expect chunking — that is the intended fix.)

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/chapter-chunker.ts server/src/analyzer/chapter-chunker.test.ts server/src/routes/script-review.ts server/src/routes/annotate-emotion.ts server/src/routes/instruct-annotation.ts
git commit -m "feat(server): size cloud output-heavy passes to the token cap incl. roster overhead (#1682)"
```

---

## Task 5: Gemma free-tier TPM (finite) + 0/unlimited sentinel + 26b knob

**Files:**
- Modify: `server/src/analyzer/rate-limit.ts:30-67`
- Modify: `server/src/config/registry.ts` (`rate.tpm.gemma` default; add `rate.tpm.gemma26`)
- Test: `server/src/analyzer/rate-limit.test.ts`

- [ ] **Step 1: Write failing tests** — append to `rate-limit.test.ts`:

```ts
it('paces a second Gemma request against the finite 16000 TPM', async () => {
  const limiter = new GeminiRateLimiter();
  const waits: number[] = [];
  await limiter.acquire('gemma-4-31b-it', 12000, { onWait: (ms) => waits.push(ms) });
  // second 12k request cannot fit alongside the first in a 16k window → must wait
  const p = limiter.acquire('gemma-4-31b-it', 12000, { onWait: (ms) => waits.push(ms) });
  await Promise.race([p, new Promise((r) => setTimeout(r, 20))]);
  expect(waits.some((w) => w > 0)).toBe(true);
});

it('treats env TPM 0 as unlimited even though the builtin is finite', () => {
  process.env.GEMINI_TPM_GEMMA_4_31B_IT = '0';
  const limiter = new GeminiRateLimiter();
  // 40k-token request must acquire immediately (unlimited), no throw
  return expect(limiter.acquire('gemma-4-31b-it', 40000)).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd server && npm run test -- src/analyzer/rate-limit.test.ts`
Expected: FAIL (builtin TPM still Infinity → second request never waits; and 0 currently already unlimited so the second test passes only by accident — after Step 3 it must still pass).

- [ ] **Step 3: Implement** — `rate-limit.ts`:

Change both Gemma builtins (`:41-42`):

```ts
  'gemma-4-31b-it': { rpm: 15, tpm: 16_000, rpd: 1500 },
  'gemma-4-26b-a4b-it': { rpm: 15, tpm: 16_000, rpd: 1500 },
```

Make the `0`/`unlimited` sentinel explicit in `readEnvNumber` (`:51-57`) so it no longer depends on the builtin being Infinity:

```ts
function readEnvNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const t = raw.trim().toLowerCase();
  if (t === 'unlimited' || t === '0') return Infinity; // explicit "no gate" sentinel
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
```

- [ ] **Step 4: Registry** — change `rate.tpm.gemma` default `0 → 16000`, update help; add `rate.tpm.gemma26`:

```ts
  // rate.tpm.gemma: default 16000, help: 'Input-tokens/min for gemma-4-31b-it (free tier 16000). Set 0 (or "unlimited") for a paid key.'
  {
    key: 'rate.tpm.gemma26',
    env: 'GEMINI_TPM_GEMMA_4_26B_A4B_IT',
    group: 'rate-limits',
    label: 'Gemma 4 26B A4B TPM',
    help: 'Input-tokens/min for gemma-4-26b-a4b-it (free tier 16000). Set 0 (or "unlimited") for a paid key.',
    type: 'integer', min: 0,
    default: 16000,
    apply: 'restart-server', risk: 'low',
  },
```

- [ ] **Step 5: `config:sync`, run tests**

Run: `cd server && npm run config:sync && npm run test -- src/analyzer/rate-limit.test.ts`
Expected: PASS. Reset `process.env.GEMINI_TPM_GEMMA_4_31B_IT` in an `afterEach`.

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/rate-limit.ts server/src/analyzer/rate-limit.test.ts server/src/config/registry.ts server/src/config/generated*
git commit -m "fix(server): finite Gemma free-tier TPM + explicit 0/unlimited sentinel + 26b knob (#1682)"
```

---

## Task 6: Fail-fast guard — `acquire()` never hangs on an over-TPM request

**Files:**
- Modify: `server/src/analyzer/rate-limit.ts` (guard + `RequestExceedsTpmError`)
- Modify: `server/src/routes/failure-taxonomy.ts` (classify it)
- Test: `server/src/analyzer/rate-limit.test.ts`

**Interfaces:**
- Produces: `class RequestExceedsTpmError extends Error { code = 'REQUEST_EXCEEDS_TPM'; model; estimated; cap }`.

- [ ] **Step 1: Write failing test**

```ts
it('fails fast when a single request exceeds a finite TPM (never spins)', async () => {
  const limiter = new GeminiRateLimiter();
  const start = Date.now();
  await expect(limiter.acquire('gemma-4-31b-it', 25000)).rejects.toMatchObject({
    code: 'REQUEST_EXCEEDS_TPM',
  });
  expect(Date.now() - start).toBeLessThan(1000); // did NOT wait 60s
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd server && npm run test -- src/analyzer/rate-limit.test.ts`
Expected: FAIL — the call hangs / times out (the current `while(true)` never rejects).

- [ ] **Step 3: Implement the guard** — in `rate-limit.ts`, add the error class and guard at the top of `acquire()` (after `const limits = resolveLimits(model);`, before the `while` loop):

```ts
export class RequestExceedsTpmError extends Error {
  readonly code = 'REQUEST_EXCEEDS_TPM';
  constructor(
    public readonly model: string,
    public readonly estimated: number,
    public readonly cap: number,
  ) {
    super(
      `Gemini ${model}: request estimate ${estimated} tokens exceeds the ${cap} tokens/min cap — ` +
        `no single request can fit. Lower analyzer.gemini.maxInputTokensPerRequest or raise TPM.`,
    );
    this.name = 'RequestExceedsTpmError';
  }
}
```

```ts
    // Fail fast: a single request larger than the whole per-minute budget can
    // never be satisfied — do not spin the wait loop forever (RC5).
    if (Number.isFinite(limits.tpm) && estimatedTokens > limits.tpm) {
      throw new RequestExceedsTpmError(model, estimatedTokens, limits.tpm);
    }
```

- [ ] **Step 4: Classify it in failure-taxonomy** — add a signature entry (near the other analyzer signatures) so it surfaces cleanly rather than as `unknown`:

```ts
  {
    code: 'analyzer-rate-limit',
    fatal: false,
    source: 'analysis',
    matchName: 'RequestExceedsTpmError',
    match: () => false,
  },
```

> Place it AFTER the `analyzer-daily-quota` entry (name-driven matches are order-sensitive per the file's header comment). Confirm `analyzer-rate-limit` already exists as a `FailureCode`; if a distinct remediation is wanted, add `analyzer-request-too-large` to the `FailureCode` union + `FAILURE_REMEDIATIONS` — otherwise reuse `analyzer-rate-limit`.

- [ ] **Step 5: Run tests**

Run: `cd server && npm run test -- src/analyzer/rate-limit.test.ts src/routes/failure-taxonomy.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/rate-limit.ts server/src/analyzer/rate-limit.test.ts server/src/routes/failure-taxonomy.ts
git commit -m "fix(server): fail-fast when a request exceeds TPM so acquire() never hangs (#1682)"
```

---

## Task 7: Narrow the daily-quota classifier in `gemini.ts`

**Files:**
- Modify: `server/src/analyzer/gemini.ts:591`
- Test: `server/src/analyzer/gemini.test.ts:490`

- [ ] **Step 1: Write failing tests** — in `gemini.test.ts`, using the real per-minute envelope:

```ts
it('retries a per-minute input-token 429 (not DailyQuotaExhaustedError)', async () => {
  const err = Object.assign(new Error(
    '{"error":{"message":"Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, ' +
    'quotaId: GenerateContentInputTokensPerModelPerMinute-FreeTier, retryDelay: 49s","status":"RESOURCE_EXHAUSTED"}}'),
    { status: 429 },
  );
  // drive a stubbed generate that throws `err` once then succeeds; assert it retried and did NOT throw DailyQuotaExhaustedError
  // (mirror the existing 429 retry test harness in this file)
});

it('throws DailyQuotaExhaustedError on a genuine per_day 429', async () => {
  // message contains generate_requests_per_model_per_day_free_tier
});
```

- [ ] **Step 2: Run, verify the per-minute test fails**

Run: `cd server && npm run test -- src/analyzer/gemini.test.ts`
Expected: FAIL — per-minute currently classified as `DailyQuotaExhaustedError`.

- [ ] **Step 3: Implement** — `gemini.ts:591`, replace the daily-quota condition:

```ts
          if (/per[_-]?day|quotaValue":"\d{1,3}"/i.test(message)) {
```

(drop the `free[_-]?tier` alternative; keep the small-value heuristic). Update the existing daily-quota test at `:494` to use a `generate_requests_per_model_per_day_free_tier` message so it still asserts the throw.

- [ ] **Step 4: Run tests**

Run: `cd server && npm run test -- src/analyzer/gemini.test.ts`
Expected: PASS (per-minute retries; per_day still throws).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/gemini.ts server/src/analyzer/gemini.test.ts
git commit -m "fix(server): classify per-minute 429 as retryable, not daily quota (gemini.ts) (#1682)"
```

---

## Task 8: Narrow the daily-quota classifier in `failure-taxonomy.ts` (both sites)

**Files:**
- Modify: `server/src/routes/failure-taxonomy.ts:113` (raw) and `:414` (message)
- Test: `server/src/routes/failure-taxonomy.test.ts`

- [ ] **Step 1: Write failing tests** — append to `failure-taxonomy.test.ts`:

```ts
it('classifies a per-minute input-token 429 as analyzer-rate-limit (not daily)', () => {
  const raw = 'got status: 429. {"error":{"message":"Quota exceeded ... generate_content_free_tier_input_token_count, ' +
    'quotaId: GenerateContentInputTokensPerModelPerMinute-FreeTier","status":"RESOURCE_EXHAUSTED","details":[{"quotaValue":"16000"}]}}';
  expect(classify(raw, { status: 429 }).code).toBe('analyzer-rate-limit');
});

it('still classifies a per_day 429 as analyzer-daily-quota', () => {
  // the existing :341 fixture (generate_requests_per_model_per_day_free_tier) stays daily
});
```

(Use whatever the file's public entry point is — mirror `failure-taxonomy.test.ts:341`.)

- [ ] **Step 2: Run, verify the per-minute test fails**

Run: `cd server && npm run test -- src/routes/failure-taxonomy.test.ts`
Expected: FAIL — per-minute currently → `analyzer-daily-quota`.

- [ ] **Step 3: Implement** — at both sites drop `free[_-]?tier`, match daily on `per_day`:

`:113`:
```ts
    match: (raw, ctx) =>
      ctx.status === 429 && /per[_-]?day|quotaValue":"\d{1,3}"/i.test(raw),
```
`:414`:
```ts
    if (message && /per[_-]?day|quotaValue":"\d{1,3}"/i.test(message)) return 'analyzer-daily-quota';
```

Update the two "Same free-tier regex …" comments (`:110-111`, `:412-413`) to describe the `per_day` marker.

- [ ] **Step 4: Run tests**

Run: `cd server && npm run test -- src/routes/failure-taxonomy.test.ts`
Expected: PASS (per-minute → rate-limit; per_day fixture → daily).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/failure-taxonomy.ts server/src/routes/failure-taxonomy.test.ts
git commit -m "fix(server): per-minute 429 not misclassified daily in failure-taxonomy (#1682)"
```

---

## Task 9: Docs — regression plan + release notes

**Files:**
- Modify: `docs/features/archive/06-analyzer-gemini.md` (limits table: Gemma TPM Unlimited → 16000/min; note the per-request cap + fail-fast + per-minute classification)
- Modify: `docs/release-notes-next.md` (technical entry, `Refs #1682`)
- Modify: `RELEASE_NOTES.md` (brand-voice line in the in-progress version section)

- [ ] **Step 1: Update the regression plan** — in `06-analyzer-gemini.md`, change the Gemma TPM row to `16,000/min (free tier)`, and add a short subsection documenting: per-request input cap (`maxInputTokensPerRequest`, default 12000), the `PerMinute` vs `per_day` classification, and the `acquire()` fail-fast guard. Add a manual acceptance line: "free-tier Gemma analysis of a large Russian book completes throttled, no dropped chapters, no hang."

- [ ] **Step 2: Add release notes**

`docs/release-notes-next.md`:
```
- Analyzer: cloud (Gemini/Gemma) requests are now sized to the free-tier's
  16k input-tokens/minute limit across every pass (cast detection, attribution,
  script review), a per-minute rate-limit is retried instead of being mistaken
  for daily-quota exhaustion, and the limiter can no longer hang on an oversized
  request. (Refs #1682)
```
`RELEASE_NOTES.md` (in-progress section, brand voice):
```
- **Big books on the free tier no longer stall.** Castwright now paces cloud
  analysis to the free plan's per-minute limits, so a long book finishes —
  slower, but complete — instead of dropping chapters.
```

- [ ] **Step 3: Commit**

```bash
git add docs/features/archive/06-analyzer-gemini.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): analyzer cloud request-sizing regression plan + release notes (#1682)"
```

---

## Final verification (before PR)

- [ ] `cd server && npm run test:server` — full server suite green.
- [ ] `npm run typecheck` — clean (worktree needs `server/node_modules` junctioned — already done).
- [ ] `npm run config:check` — registry/generated in sync.
- [ ] **Knob-parity check:** every new env var (`ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST`, `ANALYZER_STAGE1_LOCAL_INPUT_FRACTION`, `ANALYZER_STAGE2_LOCAL_INPUT_FRACTION`, `GEMINI_TPM_GEMMA_4_26B_A4B_IT`) appears in BOTH `registry.ts` (as a knob) AND `server/.env.example`. Grep each name in both files; no env-only reads.
- [ ] `npm run verify:fast:branch` — the pre-push battery.
- [ ] Manual (on-box, owner): free-tier Gemma re-analysis of *Ночной дозор* completes without dropped chapters or hang; calibrate `analyzer.stage2.localInputFraction` against a Qwen local truncation trace.
- [ ] Open PR: `fix/server-cloud-request-sizing` → `main`, body `Closes #1682`, link this plan + the spec; run the mandatory `code-review` gate.
