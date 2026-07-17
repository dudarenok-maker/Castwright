# Analyzer eval-rate telemetry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture real Ollama decode timing (tok/s) per analysis pass and surface a persisted, trend-over-time view in the Admin console, so the operator can spot analyzer speed drift across a long run without grepping logs.

**Architecture:** Ollama's `chat()` already parses the `done:true` line — capture its timing fields and fire a new `onEvalTiming` sink per call. Each analysis pass reuses one `StageCall`, so a `withPassEval` wrapper accumulates every sub-call (chunks × retries) on that call and, at the pass-orchestration boundary, folds them into ONE token-weighted `AnalyzerEvalRecord` appended to a serialized JSONL store. A `GET /api/generation/analyzer-stats` endpoint feeds a new `AnalyzerTrends` admin panel that buckets records by `(manuscriptId, model)`.

**Tech Stack:** TypeScript (server: Node/Express + Vitest; frontend: React 18 + RTK + Vitest/RTL), append-only JSONL telemetry (mirrors `resource-telemetry.ts` / `model-vram-stats.ts`), inline-SVG sparkline (no charting dep).

## Global Constraints

- **Best-effort telemetry, never throws on the analysis hot path.** A write/read failure is swallowed; a corrupt trailing JSONL line is skipped, not thrown. (Copied from spec Storage section.)
- **Every new env var is a registry knob + `.env.example`.** Add `analyzer.evalStats.enabled` (env `CASTWRIGHT_EVAL_SAMPLE`, default **true**) to `server/src/config/registry.ts` and run `npm run config:sync` **in the same commit** (else `config:check` fails in `verify:fast:branch`).
- **Concurrency invariant (Critical — analysis is pipelined).** The per-pass accumulator MUST be a fresh local created per pass-invocation on that pass's own `StageCall` (Phase 0/Phase 1 run concurrently; Phase 1 keeps N chapters in flight — `analysis.ts:4237-4240`). `withPassEval` enforces this by construction. Never introduce a module-level "current pass" sink.
- **Serialized JSONL appends** via a module-level promise-chain mutex — N pipelined workers can append concurrently; the read-trim-rewrite must not race.
- **Group by `(manuscriptId, model)` key**, not contiguous runs (`ResourceTrends`' fold would shatter under concurrent multi-book).
- **No hex literals in component code** — use the existing Tailwind/CSS-var tokens (match `ResourceTrends`).
- **Telemetry record types are hand-defined**, not OpenAPI-generated (mirror `ResourceTelemetryRecord` in `src/lib/types.ts`). The server type is the source; the frontend type is a hand-kept mirror.
- Spec of record: `docs/superpowers/specs/2026-07-17-analyzer-eval-rate-telemetry-design.md`.

---

### Task 1: Telemetry store + fold + pass wrapper (`analyzer-eval-stats.ts`)

Self-contained pure/IO core — no dependency on the capture wiring. Mirrors `resource-telemetry.ts` + `model-vram-stats.ts`.

**Files:**
- Create: `server/src/analyzer/analyzer-eval-stats.ts`
- Test: `server/src/analyzer/analyzer-eval-stats.test.ts`

**Interfaces:**
- Produces: `RawEvalTiming`, `AnalyzerEvalRecord`, `PassContext`, `canonicalModel(model)`, `foldPassTiming(acc)`, `appendAnalyzerEval(rec)`, `readAnalyzerEvalRecords(limit?)`, `recordPassEval(acc, ctx)`, `withPassEval(call, ctx, fn, chunkCountOf?)`, `ANALYZER_EVAL_MAX_LINES`, `analyzerEvalStatsFilePath()`, `__resetAnalyzerEvalQueueForTest()`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/analyzer/analyzer-eval-stats.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'aes-'));
vi.mock('../workspace/paths.js', () => ({ telemetryDir: () => dir }));

import {
  foldPassTiming, canonicalModel, recordPassEval, withPassEval,
  readAnalyzerEvalRecords, appendAnalyzerEval, analyzerEvalStatsFilePath,
  ANALYZER_EVAL_MAX_LINES, __resetAnalyzerEvalQueueForTest,
  type RawEvalTiming, type AnalyzerEvalRecord,
} from './analyzer-eval-stats.js';
import { readFileSync, writeFileSync } from 'node:fs';

const t = (o: Partial<RawEvalTiming>): RawEvalTiming => ({
  model: 'qwen36-castwright', evalCount: 0, evalDuration: 0,
  promptEvalCount: 0, promptEvalDuration: 0, loadDuration: 0, ...o,
});

beforeEach(() => { __resetAnalyzerEvalQueueForTest(); try { writeFileSync(analyzerEvalStatsFilePath(), ''); } catch {} });

describe('foldPassTiming', () => {
  it('token-weights tok/s across sub-calls (not a mean of rates)', () => {
    // 100 tok in 1e9 ns (100 t/s) + 900 tok in 9e9 ns (100 t/s) → 1000 tok / 10s = 100
    const f = foldPassTiming([t({ evalCount: 100, evalDuration: 1e9 }), t({ evalCount: 900, evalDuration: 9e9 })]);
    expect(f?.evalTokS).toBeCloseTo(100, 5);
    expect(f?.evalCount).toBe(1000);
    expect(f?.subCalls).toBe(2);
  });
  it('loadMs is the MAX over sub-calls, in ms', () => {
    const f = foldPassTiming([t({ loadDuration: 0 }), t({ loadDuration: 610_000_000 })]);
    expect(f?.loadMs).toBeCloseTo(610, 5);
  });
  it('null tok/s when summed duration is 0', () => {
    expect(foldPassTiming([t({ evalCount: 5, evalDuration: 0 })])?.evalTokS).toBeNull();
  });
  it('returns null for an empty accumulator', () => {
    expect(foldPassTiming([])).toBeNull();
  });
  it('canonicalises the model tag', () => {
    expect(canonicalModel('qwen36-castwright')).toBe('qwen36-castwright:latest');
    expect(foldPassTiming([t({ model: 'gemma4-e4b-8gb' })])?.model).toBe('gemma4-e4b-8gb:latest');
  });
});

describe('recordPassEval', () => {
  it('appends one folded record; empty acc is a no-op', async () => {
    await recordPassEval([], { manuscriptId: 'm', bookTitle: null, stage: 'stage2-ch', chapterId: 1, chunkCount: 1, outcome: 'ok' });
    await recordPassEval([t({ evalCount: 50, evalDuration: 1e9 })], { manuscriptId: 'm', bookTitle: 'Book', stage: 'stage2-ch', chapterId: 3, chunkCount: 2, outcome: 'ok' });
    const recs = await readAnalyzerEvalRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ manuscriptId: 'm', stage: 'stage2-ch', chapterId: 3, chunkCount: 2, evalTokS: 50, subCalls: 1, outcome: 'ok' });
  });
});

describe('withPassEval', () => {
  it('accumulates sub-calls fired on the call and emits one record', async () => {
    const call: { onEvalTiming?: (t: RawEvalTiming) => void } = {};
    const r = await withPassEval(call, { manuscriptId: 'm', bookTitle: null, stage: 'stage2-ch', chapterId: 1 },
      async () => { call.onEvalTiming!(t({ evalCount: 10, evalDuration: 1e9 })); call.onEvalTiming!(t({ evalCount: 30, evalDuration: 1e9 })); return { chunkCount: 4 }; },
      (res) => res.chunkCount);
    expect(r.chunkCount).toBe(4);
    const recs = await readAnalyzerEvalRecords();
    expect(recs[0]).toMatchObject({ subCalls: 2, evalCount: 40, chunkCount: 4, outcome: 'ok' });
  });
  it('records outcome:failed and rethrows when the pass throws', async () => {
    const call: { onEvalTiming?: (t: RawEvalTiming) => void } = {};
    await expect(withPassEval(call, { manuscriptId: 'm', bookTitle: null, stage: 'stage2-ch', chapterId: 1 },
      async () => { call.onEvalTiming!(t({ evalCount: 5, evalDuration: 1e9 })); throw new Error('boom'); })
    ).rejects.toThrow('boom');
    const recs = await readAnalyzerEvalRecords();
    expect(recs[0]).toMatchObject({ outcome: 'failed', chunkCount: null, subCalls: 1 });
  });
  it('two concurrent passes on DISTINCT calls do not cross-contaminate', async () => {
    const a: { onEvalTiming?: (t: RawEvalTiming) => void } = {};
    const b: { onEvalTiming?: (t: RawEvalTiming) => void } = {};
    await Promise.all([
      withPassEval(a, { manuscriptId: 'A', bookTitle: null, stage: 'stage2-ch', chapterId: 1 },
        async () => { a.onEvalTiming!(t({ evalCount: 100, evalDuration: 1e9 })); await new Promise((r) => setTimeout(r, 5)); a.onEvalTiming!(t({ evalCount: 100, evalDuration: 1e9 })); }),
      withPassEval(b, { manuscriptId: 'B', bookTitle: null, stage: 'stage2-ch', chapterId: 1 },
        async () => { b.onEvalTiming!(t({ evalCount: 300, evalDuration: 1e9 })); }),
    ]);
    const recs = await readAnalyzerEvalRecords();
    const byBook = Object.fromEntries(recs.map((r) => [r.manuscriptId, r]));
    expect(byBook.A.evalCount).toBe(200);
    expect(byBook.B.evalCount).toBe(300);
  });
});

describe('store IO', () => {
  it('reads newest-first and honours limit', async () => {
    for (let i = 1; i <= 3; i++) await recordPassEval([t({ evalCount: i, evalDuration: 1e9 })], { manuscriptId: 'm', bookTitle: null, stage: 'stage2-ch', chapterId: i, chunkCount: 1, outcome: 'ok' });
    const recs = await readAnalyzerEvalRecords(2);
    expect(recs.map((r) => r.chapterId)).toEqual([3, 2]);
  });
  it('skips a corrupt trailing line', async () => {
    await recordPassEval([t({ evalCount: 1, evalDuration: 1e9 })], { manuscriptId: 'm', bookTitle: null, stage: 'stage2-ch', chapterId: 1, chunkCount: 1, outcome: 'ok' });
    writeFileSync(analyzerEvalStatsFilePath(), readFileSync(analyzerEvalStatsFilePath(), 'utf8') + '{ not json\n');
    expect(await readAnalyzerEvalRecords()).toHaveLength(1);
  });
  it('trims to the cap, keeping newest', async () => {
    const lines = Array.from({ length: ANALYZER_EVAL_MAX_LINES + 5 }, (_, i) =>
      JSON.stringify({ at: new Date(0).toISOString(), manuscriptId: 'm', bookTitle: null, model: 'x:latest', stage: 'stage2-ch', chapterId: i, evalTokS: 1, promptTokS: null, evalCount: 1, loadMs: 0, subCalls: 1, chunkCount: 1, outcome: 'ok' } as AnalyzerEvalRecord)).join('\n') + '\n';
    writeFileSync(analyzerEvalStatsFilePath(), lines);
    await appendAnalyzerEval({ at: new Date().toISOString(), manuscriptId: 'm', bookTitle: null, model: 'x:latest', stage: 'stage2-ch', chapterId: 9999, evalTokS: 1, promptTokS: null, evalCount: 1, loadMs: 0, subCalls: 1, chunkCount: 1, outcome: 'ok' });
    const recs = await readAnalyzerEvalRecords();
    expect(recs).toHaveLength(ANALYZER_EVAL_MAX_LINES);
    expect(recs[0].chapterId).toBe(9999); // newest kept
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd server && npx vitest run src/analyzer/analyzer-eval-stats.test.ts`
Expected: FAIL — module `./analyzer-eval-stats.js` not found.

- [ ] **Step 3: Write the implementation**

```ts
// server/src/analyzer/analyzer-eval-stats.ts
/* Analyzer eval-rate telemetry store. One record per (manuscript, chapter,
   analysis pass), folding EVERY Ollama chat() sub-call under that pass (chunks
   × coverage retries × validation retries). Append-only JSONL, best-effort,
   serialized so N pipelined analysis workers can't race the trim. Mirrors
   resource-telemetry.ts (fs-20) + model-vram-stats.ts (fs-45). */

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { telemetryDir } from '../workspace/paths.js';

/** Raw timing off one Ollama /api/chat `done:true` line. Durations in ns. */
export interface RawEvalTiming {
  model: string;
  evalCount: number;
  evalDuration: number;
  promptEvalCount: number;
  promptEvalDuration: number;
  loadDuration: number;
}

export interface AnalyzerEvalRecord {
  at: string;
  manuscriptId: string;
  bookTitle: string | null;
  model: string;
  stage: string;
  chapterId: number | 'book';
  evalTokS: number | null;
  promptTokS: number | null;
  evalCount: number;
  loadMs: number;
  subCalls: number;
  chunkCount: number | null;
  outcome: 'ok' | 'failed';
}

export interface PassContext {
  manuscriptId: string;
  bookTitle: string | null;
  stage: string;
  chapterId: number | 'book';
  chunkCount: number | null;
  outcome: 'ok' | 'failed';
}

/* ~2000 records is many full books; past that drop the oldest. */
export const ANALYZER_EVAL_MAX_LINES = 2000;

export function analyzerEvalStatsFilePath(): string {
  return join(telemetryDir(), 'analyzer-eval-stats.jsonl');
}

/** Ollama canonical tag: a bare family name resolves to ':latest'. */
export function canonicalModel(model: string): string {
  return model.includes(':') ? model : `${model}:latest`;
}

const rate = (count: number, durNs: number): number | null =>
  durNs > 0 ? count / (durNs / 1e9) : null;

/** Fold a pass's raw sub-call timings. Returns null on an empty accumulator
    (nothing decoded locally — e.g. a Gemini-only pass). tok/s is token-weighted
    (ΣevalCount / ΣevalDuration), NOT a mean of per-call rates. loadMs = max. */
export function foldPassTiming(acc: RawEvalTiming[]): {
  model: string; evalTokS: number | null; promptTokS: number | null;
  evalCount: number; loadMs: number; subCalls: number;
} | null {
  if (acc.length === 0) return null;
  let evalCount = 0, evalDur = 0, promptCount = 0, promptDur = 0, loadNs = 0;
  for (const x of acc) {
    evalCount += x.evalCount; evalDur += x.evalDuration;
    promptCount += x.promptEvalCount; promptDur += x.promptEvalDuration;
    if (x.loadDuration > loadNs) loadNs = x.loadDuration;
  }
  return {
    model: canonicalModel(acc[acc.length - 1].model),
    evalTokS: rate(evalCount, evalDur),
    promptTokS: rate(promptCount, promptDur),
    evalCount,
    loadMs: loadNs / 1e6,
    subCalls: acc.length,
  };
}

/* Serialized writer — a promise-chain mutex so a concurrent trim never races an
   append and drops lines (N pipelined analysis workers append concurrently). */
let writeQueue: Promise<void> = Promise.resolve();

export function __resetAnalyzerEvalQueueForTest(): void {
  writeQueue = Promise.resolve();
}

export function appendAnalyzerEval(rec: AnalyzerEvalRecord): Promise<void> {
  writeQueue = writeQueue.then(() => appendAndTrim(rec)).catch(() => {});
  return writeQueue;
}

async function appendAndTrim(rec: AnalyzerEvalRecord): Promise<void> {
  const path = analyzerEvalStatsFilePath();
  try {
    await mkdir(telemetryDir(), { recursive: true });
    await appendFile(path, `${JSON.stringify(rec)}\n`, 'utf8');
    const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim().length > 0);
    if (lines.length > ANALYZER_EVAL_MAX_LINES) {
      await writeFile(path, `${lines.slice(lines.length - ANALYZER_EVAL_MAX_LINES).join('\n')}\n`, 'utf8');
    }
  } catch {
    /* observability, not correctness — never break a run */
  }
}

/** Read newest-first, optionally capped. Skips a corrupt/partial trailing line;
    a missing file returns []. */
export async function readAnalyzerEvalRecords(limit?: number): Promise<AnalyzerEvalRecord[]> {
  let raw: string;
  try { raw = await readFile(analyzerEvalStatsFilePath(), 'utf8'); }
  catch { return []; }
  const out: AnalyzerEvalRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed) as AnalyzerEvalRecord); } catch { /* skip */ }
  }
  out.reverse();
  return limit != null && limit >= 0 ? out.slice(0, limit) : out;
}

/** Fold + append one pass's timing. No-op on an empty accumulator. Never throws. */
export function recordPassEval(acc: RawEvalTiming[], ctx: PassContext): Promise<void> {
  const folded = foldPassTiming(acc);
  if (!folded) return Promise.resolve();
  return appendAnalyzerEval({
    at: new Date().toISOString(),
    manuscriptId: ctx.manuscriptId,
    bookTitle: ctx.bookTitle,
    model: folded.model,
    stage: ctx.stage,
    chapterId: ctx.chapterId,
    evalTokS: folded.evalTokS,
    promptTokS: folded.promptTokS,
    evalCount: folded.evalCount,
    loadMs: folded.loadMs,
    subCalls: folded.subCalls,
    chunkCount: ctx.chunkCount,
    outcome: ctx.outcome,
  });
}

/** Wrap one pass invocation: install a FRESH accumulator on `call.onEvalTiming`,
    run `fn`, and emit exactly one record in a finally (outcome:'failed' if it
    threw). The fresh-per-call accumulator is the concurrency invariant — each
    pipelined pass owns a distinct `call`, so records never cross-contaminate.
    `chunkCountOf` reads chunkCount off the success result (null on failure). */
export async function withPassEval<T>(
  call: { onEvalTiming?: (t: RawEvalTiming) => void },
  ctx: Omit<PassContext, 'chunkCount' | 'outcome'>,
  fn: () => Promise<T>,
  chunkCountOf?: (result: T) => number | null,
): Promise<T> {
  const acc: RawEvalTiming[] = [];
  call.onEvalTiming = (x) => acc.push(x);
  let chunkCount: number | null = null;
  let outcome: 'ok' | 'failed' = 'ok';
  try {
    const result = await fn();
    chunkCount = chunkCountOf ? chunkCountOf(result) : null;
    return result;
  } catch (e) {
    outcome = 'failed';
    throw e;
  } finally {
    void recordPassEval(acc, { ...ctx, chunkCount, outcome });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/analyzer/analyzer-eval-stats.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/analyzer-eval-stats.ts server/src/analyzer/analyzer-eval-stats.test.ts
git commit -m "feat(analyzer): eval-rate telemetry store + pass-fold wrapper"
```

---

### Task 2: Capture seam — `onEvalTiming` in `chat()`, `StageCall`, registry knob

Wire timing out of Ollama and gate it behind the registry knob. No route changes yet — this task's deliverable is "a `chat()` call fires `onEvalTiming`."

**Files:**
- Modify: `server/src/analyzer/index.ts` (add `onEvalTiming` to `StageCall`)
- Modify: `server/src/analyzer/ollama.ts` (capture done-line timing; fire the sink; forward through `runStage`)
- Modify: `server/src/config/registry.ts` (add `analyzer.evalStats.enabled`)
- Modify: `server/.env.example` (regenerated via `config:sync`)
- Test: `server/src/analyzer/ollama.test.ts`

**Interfaces:**
- Consumes: `RawEvalTiming` from Task 1 (`./analyzer-eval-stats.js`).
- Produces: `StageCall.onEvalTiming?: (t: RawEvalTiming) => void`; `OllamaAnalyzer.chat()` fires it once per call when `analyzer.evalStats.enabled` is true.

- [ ] **Step 1: Add the registry knob and regenerate `.env.example`**

In `server/src/config/registry.ts`, add this entry to the knob array (place it beside the other `analyzer.ollama.*` entries; use the **same `group` string** those use — grep `key: 'analyzer.ollama.temperature'` and copy its `group`):

```ts
  {
    key: 'analyzer.evalStats.enabled',
    env: 'CASTWRIGHT_EVAL_SAMPLE',
    group: 'analyzer', // ← match the group on analyzer.ollama.* entries
    label: 'Analyzer eval-rate telemetry',
    help: 'Record per-pass Ollama decode speed (tok/s) to a JSONL log shown in '
        + "the Admin analyzer-throughput panel. Best-effort; turn off to disable capture.",
    type: 'boolean',
    default: true,
    apply: 'live', risk: 'low',
  },
```

Run: `npm run config:sync` (regenerates `server/.env.example`).
Verify: `npm run config:check` → exits 0.

- [ ] **Step 2: Write the failing test**

Add to `server/src/analyzer/ollama.test.ts` (reuse the file's existing NDJSON-stream stubbing pattern — model a `done:true` line carrying timing, and assert the sink fires):

```ts
it('fires onEvalTiming with raw counts + model off the done line', async () => {
  const timings: RawEvalTiming[] = [];
  // Arrange a stubbed fetch whose stream ends with a done line carrying timing.
  // (Follow the existing helper in this file that builds an NDJSON ReadableStream;
  //  the final line must include eval_count/eval_duration/prompt_eval_count/
  //  prompt_eval_duration/load_duration and done:true.)
  await runStageWithStubbedStream({
    lines: [
      { message: { content: '{"characters":[]}' } },
      { done: true, done_reason: 'stop', eval_count: 120, eval_duration: 4_000_000_000, prompt_eval_count: 800, prompt_eval_duration: 2_000_000_000, load_duration: 0 },
    ],
    onEvalTiming: (t) => timings.push(t),
  });
  expect(timings).toHaveLength(1);
  expect(timings[0]).toMatchObject({ model: expect.any(String), evalCount: 120, evalDuration: 4_000_000_000, promptEvalCount: 800, loadDuration: 0 });
});

it('does not fire onEvalTiming when analyzer.evalStats.enabled is false', async () => {
  // set CASTWRIGHT_EVAL_SAMPLE=0 (or stub configValue) for this case
});
```

> Implementer note: `ollama.test.ts` already stubs `global.fetch` with a streamed body for the existing `chat()` tests — extend that harness with an `onEvalTiming` param rather than inventing a new one. If no reusable helper exists, add `import type { RawEvalTiming } from './analyzer-eval-stats.js'` and build the stream inline mirroring the nearest existing streaming test.

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd server && npx vitest run src/analyzer/ollama.test.ts -t onEvalTiming`
Expected: FAIL — `onEvalTiming` is not a parameter / never called.

- [ ] **Step 4: Implement the capture**

In `server/src/analyzer/index.ts`, add to the `StageCall` interface (next to `onChunk`):

```ts
  /** Fired once per Ollama chat() call with that call's decode timing. The
      analysis route accumulates these per pass (see withPassEval). Only the
      local Ollama analyzer fires it; Gemini never does. */
  onEvalTiming?: (t: RawEvalTiming) => void;
```

and at the top of `index.ts`: `import type { RawEvalTiming } from './analyzer-eval-stats.js';`

In `server/src/analyzer/ollama.ts`:

1. Import the config reader + type (top of file):
```ts
import type { RawEvalTiming } from './analyzer-eval-stats.js';
// configValue is already imported.
```

2. Extend `chat()`'s signature with the sink (after `signal`):
```ts
  private async chat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    responseFormat: unknown,
    temperature: number,
    onChunk?: (info: StageChunkInfo) => void,
    signal?: AbortSignal,
    onEvalTiming?: (t: RawEvalTiming) => void,
  ): Promise<string> {
```

3. Widen the `parsed` line type and capture timing on the done line. Replace the existing `if (parsed.done && parsed.done_reason) doneReason = parsed.done_reason;` block (around L734) with:
```ts
            if (parsed.done) {
              if (parsed.done_reason) doneReason = parsed.done_reason;
              timing = {
                model: this.model,
                evalCount: parsed.eval_count ?? 0,
                evalDuration: parsed.eval_duration ?? 0,
                promptEvalCount: parsed.prompt_eval_count ?? 0,
                promptEvalDuration: parsed.prompt_eval_duration ?? 0,
                loadDuration: parsed.load_duration ?? 0,
              };
            }
```
Add the numeric fields to the `parsed` type annotation, and declare `let timing: RawEvalTiming | null = null;` alongside `let doneReason` near L676:
```ts
            let parsed: {
              message?: { content?: string };
              done?: boolean;
              done_reason?: string;
              error?: string;
              eval_count?: number; eval_duration?: number;
              prompt_eval_count?: number; prompt_eval_duration?: number;
              load_duration?: number;
            };
```

4. Fire the sink after the empty/truncation guards, just before `return buf;` (after the fs-45 VRAM sample block):
```ts
      if (timing && onEvalTiming && configValue<boolean>('analyzer.evalStats.enabled')) {
        onEvalTiming(timing);
      }
      return buf;
```

5. Forward `call.onEvalTiming` from `runStage` into BOTH `chat()` calls (first attempt ~L456 and retry ~L516):
```ts
      const firstText = await this.chat(
        [ { role: 'system', content: systemInstruction }, { role: 'user', content: promptMd } ],
        responseFormat, resolveOllamaTemperature(), call.onChunk, call.signal, call.onEvalTiming,
      );
```
```ts
      const secondText = await this.chat(
        retryMessages, responseFormat, retryTemperature, call.onChunk, call.signal, call.onEvalTiming,
      );
```

> Do NOT add `onEvalTiming` to the `chat()` call inside `runAttributionEscalation` (~L391) — escalation is excluded from records by design.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run src/analyzer/ollama.test.ts`
Expected: PASS (new cases + all existing `chat()` cases unchanged).

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/index.ts server/src/analyzer/ollama.ts server/src/config/registry.ts server/.env.example server/src/analyzer/ollama.test.ts
git commit -m "feat(analyzer): capture Ollama decode timing via onEvalTiming sink"
```

---

### Task 3: Route wiring — accumulate + emit at each pass boundary

Wrap each per-chapter pass so its sub-calls fold into one record. **Critical constraint (from the plan review):** `withPassEval(call, …)` needs the SAME `StageCall` object handed to both it and the runner. The stage-2 site already has a named `stage2Call` (`analysis.ts:3974`). Other sites (the stage-1 **cast** site builds its `StageCall` *inline per chunk* inside `callForBody`, `analysis.ts:3190`) must first **lift that call to a named per-chapter const** passed into the runner. Never attach to a hoisted/shared call — that breaks the pipelining isolation invariant.

**Files:**
- Modify: `server/src/routes/analysis.ts` (export `attributeChapterStage2WithEval`; call it from `runChapter` ~L4060; lift + wrap the stage-1 cast call ~L3157-3197)
- Modify: `server/src/routes/annotate-emotion.ts` (~L186, `runEmotionChapter`)
- Modify: `server/src/routes/script-review.ts` (`runScriptReviewChapter`)
- Modify: `server/src/routes/instruct-annotation.ts` (`runStage3Chapter`) and the non-story classification site
- Test: `server/src/routes/analyzer-eval-wiring.test.ts` (NEW — a **real** guard: drives the exported stage-2 wrapper with a mock analyzer that fires `onEvalTiming`)

**Interfaces:**
- Consumes: `withPassEval`, `RawEvalTiming`, `readAnalyzerEvalRecords` from Task 1.
- Produces: `attributeChapterStage2WithEval(opts)` (same opts as `attributeChapterStage2`) → `Promise<Stage2ChunkRunResult>`, exported for the test and called by `runChapter`.

Pass → `stage` string mapping (use EXACTLY these — the frontend groups/labels on them):

| Site | `stage` | `chapterId` | `chunkCountOf` |
|---|---|---|---|
| stage-2 (`attributeChapterStage2WithEval`) | `'stage2-ch'` | `opts.chapter.id` | `(r) => r.chunkCount ?? null` |
| stage-1 cast (analysis.ts ~L3157) | `'stage1-ch'` | `ch.id` | `() => null` (roster union) |
| `runEmotionChapter` (annotate-emotion.ts) | `'emotion'` | `ch.id` | `() => null` |
| `runNonStoryClassification` | `'nonstory'` | `ch.id` | `() => null` |
| `runScriptReviewChapter` (script-review.ts) | `'review'` | `ch.id` | `() => null` |
| `runStage3Chapter` (instruct-annotation.ts) | `'stage3'` | `ch.id` | `() => null` |

`bookTitle`: `recordRef.title ?? null` in `analysis.ts`, `record.title ?? null` elsewhere. `manuscriptId` is in scope at every site.

- [ ] **Step 1: Add the exported stage-2 wrapper (production code first — the test imports it)**

In `analysis.ts`, add beside `attributeChapterStage2`:

```ts
import { withPassEval } from '../analyzer/analyzer-eval-stats.js';
import type { Stage2ChunkRunResult } from '../analyzer/stage2-chunk.js';

/** Wrap attributeChapterStage2 so its many chat() sub-calls fold into ONE
    per-(chapter, pass) eval-rate record. Exported so the wiring test can drive
    it directly. `runChapter` calls this instead of attributeChapterStage2. */
export function attributeChapterStage2WithEval(
  opts: Parameters<typeof attributeChapterStage2>[0],
): Promise<Stage2ChunkRunResult> {
  return withPassEval(
    opts.stageCall,
    { manuscriptId: opts.manuscriptId, bookTitle: opts.title ?? null, stage: 'stage2-ch', chapterId: opts.chapter.id },
    () => attributeChapterStage2(opts),
    (r) => r.chunkCount ?? null,
  );
}
```

- [ ] **Step 2: Write the failing REAL guard test**

```ts
// server/src/routes/analyzer-eval-wiring.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'aew-'));
// Preserve every other paths.js export; only override telemetryDir.
vi.mock('../workspace/paths.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), telemetryDir: () => dir }));

import { attributeChapterStage2WithEval } from './analysis.js';
import { readAnalyzerEvalRecords, analyzerEvalStatsFilePath, __resetAnalyzerEvalQueueForTest } from '../analyzer/analyzer-eval-stats.js';
import type { Analyzer, StageCall } from '../analyzer/index.js';

beforeEach(() => { __resetAnalyzerEvalQueueForTest(); writeFileSync(analyzerEvalStatsFilePath(), ''); });

it('stage-2 wrapper folds the analyzer sub-calls into ONE record', async () => {
  // Mock analyzer whose runStage2Chapter fires onEvalTiming (as OllamaAnalyzer
  // does) three times, then returns canned sentences. Mirror the mock shape in
  // analysis.structure-engine.test.ts (baseOpts/mockSentences) for the other
  // Analyzer methods — reject them (unused on this path).
  const analyzer = {
    runStage2Chapter: async (_m: string, chId: number, _p: string, call: StageCall) => {
      for (let i = 0; i < 3; i++) call.onEvalTiming?.({ model: 'qwen36-castwright', evalCount: 100, evalDuration: 2e9, promptEvalCount: 300, promptEvalDuration: 1e9, loadDuration: 0 });
      return { sentences: [{ id: 1, chapterId: chId, characterId: 1, text: 'Короткий текст.' }] };
    },
    runStage1Chapter: () => Promise.reject(new Error('unused')),
    runEmotionChapter: () => Promise.reject(new Error('unused')),
    runScriptReviewChapter: () => Promise.reject(new Error('unused')),
    runStage3Chapter: () => Promise.reject(new Error('unused')),
  } as unknown as Analyzer;

  const stage2Call: StageCall = { language: 'ru', signal: new AbortController().signal };
  await attributeChapterStage2WithEval({
    analyzer, manuscriptId: 'mid', title: 'Ночной дозор',
    stage1: { characters: [] } as never,
    chapter: { id: 6, title: 'Глава 6', body: 'Короткий текст.' },
    stageCall: stage2Call,
  });

  const recs = await readAnalyzerEvalRecords();
  expect(recs).toHaveLength(1);
  expect(recs[0]).toMatchObject({ manuscriptId: 'mid', bookTitle: 'Ночной дозор', stage: 'stage2-ch', chapterId: 6, subCalls: 3, evalCount: 300 });
});
```

> This is a genuine guard: it imports `analysis.js` and exercises the real wrapper. If a refactor removes the `withPassEval` wrap from `attributeChapterStage2WithEval`, `recs` is empty and the test fails. (Task 1's tests already lock `withPassEval`'s fold/isolation/failure behaviour independently.)

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd server && npx vitest run src/routes/analyzer-eval-wiring.test.ts`
Expected: FAIL first on the missing wrapper (Step 1 not committed) or, once compiling, PASS only after the wrap is in place. (Write Step 1's wrapper WITHOUT the `withPassEval` call first to watch it fail — empty `recs` — then add the wrap.)

- [ ] **Step 4: Point `runChapter` at the wrapper + wire the remaining sites**

- **Stage-2:** in `runChapter` (~L4060) replace `await attributeChapterStage2({...})` with `await attributeChapterStage2WithEval({...})` — keep the **exact same opts object** (do not drop `engine`, `escalationAnalyzer`, `structureBudget`, `onChunk`, `onSectionDone`, `onCoverageRetry`, etc.). Add `chunkCount` to the destructure if used.

- **Stage-1 cast (lift-then-wrap):** the call is currently built inline in `callForBody` (`analysis.ts:3190`). Lift it to a named const above `runStage1Guarded`, thread it into `callForBody`, and wrap the guarded run:
```ts
const castCall: StageCall = {
  signal: abortController.signal,
  language: bookLanguage,
  onWaiting: () => sendCastLiveTick(),
  // (move the existing inline onChunk/onWaiting here unchanged)
};
// inside callForBody: analyzer.runStage1Chapter(manuscriptId, ch.id, buildStage1ChapterInbox(...), castCall)
result = await withPassEval(
  castCall,
  { manuscriptId, bookTitle: recordRef.title ?? null, stage: 'stage1-ch', chapterId: ch.id },
  () => runStage1Guarded({ /* existing opts, callForBody now closing over castCall */ }),
  () => null,
);
```

- **emotion / review / stage3 / nonstory:** if the site builds its `StageCall` inline in the `runX(...)` arg, first lift it to a named const (`const emotionCall: StageCall = {...}`), pass that const to `runX`, then wrap: `await withPassEval(emotionCall, { manuscriptId, bookTitle: record.title ?? null, stage: '<from table>', chapterId: ch.id }, () => selection.analyzer.runX(..., emotionCall))`. No `chunkCountOf` (single-call passes → chunkCount null).

- [ ] **Step 5: Run the guard test + the pipelining + structure suites**

Run: `cd server && npx vitest run src/routes/analyzer-eval-wiring.test.ts src/routes/analysis-pipelining.test.ts src/routes/analysis.structure-engine.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/analysis.ts server/src/routes/annotate-emotion.ts server/src/routes/script-review.ts server/src/routes/instruct-annotation.ts server/src/routes/analyzer-eval-wiring.test.ts
git commit -m "feat(analyzer): record per-pass eval-rate at each analysis boundary"
```

---

### Task 4: API endpoint — `GET /api/generation/analyzer-stats`

**Files:**
- Modify: `server/src/routes/generation-stats.ts`
- Test: `server/src/routes/generation-stats.test.ts`

**Interfaces:**
- Consumes: `readAnalyzerEvalRecords` from Task 1.
- Produces: `GET /api/generation/analyzer-stats?limit=` → `{ records: AnalyzerEvalRecord[] }`.

- [ ] **Step 1: Write the failing test**

Add to `server/src/routes/generation-stats.test.ts` (mirror the existing `/telemetry` test):

```ts
it('GET /analyzer-stats returns records newest-first and honours limit', async () => {
  // seed the store via recordPassEval or by writing the JSONL file the route reads,
  // then supertest GET /api/generation/analyzer-stats?limit=1 and assert shape.
  const res = await request(app).get('/api/generation/analyzer-stats?limit=1');
  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.records)).toBe(true);
});

it('GET /analyzer-stats returns { records: [] } on a read error', async () => {
  // stub readAnalyzerEvalRecords to reject; assert 200 + empty list (never 500)
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd server && npx vitest run src/routes/generation-stats.test.ts -t analyzer-stats`
Expected: FAIL — route returns 404.

- [ ] **Step 3: Implement the route**

In `server/src/routes/generation-stats.ts`:

```ts
import { readAnalyzerEvalRecords } from '../analyzer/analyzer-eval-stats.js';

/* Analyzer eval-rate telemetry (tok/s per pass), newest-first. Best-effort:
   a read failure surfaces as an empty list, not a 500 (the admin panel keeps
   its last-good snapshot — same contract as /telemetry). */
generationStatsRouter.get('/analyzer-stats', async (req, res) => {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : undefined;
  const records = await readAnalyzerEvalRecords(limit).catch(() => []);
  res.json({ records });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/generation-stats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/generation-stats.ts server/src/routes/generation-stats.test.ts
git commit -m "feat(server): GET /api/generation/analyzer-stats endpoint"
```

---

### Task 5: Frontend types + API client

**Files:**
- Modify: `src/lib/types.ts` (add `AnalyzerEvalRecord`)
- Modify: `src/lib/api.ts` (real `getAnalyzerStats` + mock + re-export)

**Interfaces:**
- Produces: `api.getAnalyzerStats(limit?) => Promise<{ records: AnalyzerEvalRecord[] }>`; `AnalyzerEvalRecord` type.

- [ ] **Step 1: Add the type** (`src/lib/types.ts`) — hand-mirror of the server record:

```ts
/** Analyzer eval-rate telemetry row (server: analyzer-eval-stats.ts). One per
    (manuscript, chapter, analysis pass). Hand-kept mirror — not OpenAPI-gen. */
export interface AnalyzerEvalRecord {
  at: string;
  manuscriptId: string;
  bookTitle: string | null;
  model: string;
  stage: string;
  chapterId: number | 'book';
  evalTokS: number | null;
  promptTokS: number | null;
  evalCount: number;
  loadMs: number;
  subCalls: number;
  chunkCount: number | null;
  outcome: 'ok' | 'failed';
}
```

- [ ] **Step 2: Add the real client** (`src/lib/api.ts`, beside `getResourceTelemetry`):

```ts
  /* Analyzer eval-rate telemetry for the Admin analyzer-throughput panel
     (GET /api/generation/analyzer-stats). Newest-first; empty when none. */
  getAnalyzerStats: async (limit?: number): Promise<{ records: AnalyzerEvalRecord[] }> => {
    const qs = limit != null ? `?limit=${limit}` : '';
    const res = await fetch(`/api/generation/analyzer-stats${qs}`);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Analyzer stats fetch failed (${res.status}): ${detail || res.statusText}`);
    }
    return res.json();
  },
```

- [ ] **Step 3: Add the mock** (`src/lib/api.ts` mock object) — a small book-scoped story, gently declining tok/s:

```ts
  getAnalyzerStats: async (limit?: number): Promise<{ records: AnalyzerEvalRecord[] }> => {
    const base = [29.4, 28.9, 27.4, 26.0, 25.3, 24.1];
    const records: AnalyzerEvalRecord[] = base.map((tps, i) => ({
      at: new Date(Date.now() - i * 60_000).toISOString(),
      manuscriptId: 'mock-nd', bookTitle: 'Ночной дозор', model: 'qwen36-castwright:latest',
      stage: i % 3 === 0 ? 'stage1-ch' : 'stage2-ch', chapterId: base.length - i,
      evalTokS: tps, promptTokS: tps * 12, evalCount: 1800, loadMs: i === 4 ? 610 : 0,
      subCalls: i % 3 === 0 ? 1 : 3, chunkCount: i % 3 === 0 ? null : 3, outcome: 'ok',
    }));
    return { records: limit != null ? records.slice(0, limit) : records };
  },
```

- [ ] **Step 4: Re-export the type** at the bottom of `api.ts` (next to the `ResourceTelemetryRecord` re-export):

```ts
export type { AnalyzerEvalRecord } from './types';
```

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/lib/types.ts src/lib/api.ts
git commit -m "feat(frontend): AnalyzerEvalRecord type + getAnalyzerStats client"
```

---

### Task 6: Admin panel — `AnalyzerTrends`

**Files:**
- Modify: `src/views/admin.tsx` (new `AnalyzerTrends` component + mount)
- Test: `src/views/admin.test.tsx`

**Interfaces:**
- Consumes: `api.getAnalyzerStats`, `AnalyzerEvalRecord` from Task 5.

- [ ] **Step 1: Write the failing test** (`src/views/admin.test.tsx`) — mock `api.getAnalyzerStats` and assert grouping + bounded scroll:

```ts
it('AnalyzerTrends buckets interleaved records by (manuscriptId, model)', async () => {
  vi.spyOn(api, 'getAnalyzerStats').mockResolvedValue({ records: [
    mk({ manuscriptId: 'A', model: 'qwen:latest', evalTokS: 24 }),
    mk({ manuscriptId: 'B', model: 'gemma:latest', evalTokS: 40 }),
    mk({ manuscriptId: 'A', model: 'qwen:latest', evalTokS: 28 }),
    mk({ manuscriptId: 'B', model: 'gemma:latest', evalTokS: 41 }),
  ] });
  render(<Admin />);
  // Two sections despite A,B,A,B interleave:
  expect(await screen.findAllByTestId('analyzer-trends-section')).toHaveLength(2);
  expect(screen.getByTestId('analyzer-trends-scroll')).toBeInTheDocument();
});

it('AnalyzerTrends shows empty state when no records', async () => {
  vi.spyOn(api, 'getAnalyzerStats').mockResolvedValue({ records: [] });
  render(<Admin />);
  expect(await screen.findByText(/No analyzer telemetry recorded yet/i)).toBeInTheDocument();
});
```

(Add a small `mk(partial)` helper building an `AnalyzerEvalRecord` with defaults.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/views/admin.test.tsx -t AnalyzerTrends`
Expected: FAIL — component absent.

- [ ] **Step 3: Implement the component** and mount it next to `<ResourceTrends />` in `admin.tsx`. Model it on `ResourceTrends` (same fetch-on-mount + last-good-on-error, same sparkline approach, same token classes — no hex literals).

```tsx
/* Analyzer eval-rate trend panel. Polls GET /api/generation/analyzer-stats,
   buckets by (manuscriptId, model) — NOT contiguous runs, so a concurrent
   multi-book run can't shatter a trend — and renders each bucket as a tok/s
   sparkline + per-(chapter,pass) table inside a bounded scroll. Falling
   tok/s = deteriorating (inverse of RTF). */
function AnalyzerTrends() {
  const [records, setRecords] = useState<AnalyzerEvalRecord[] | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () => api.getAnalyzerStats(400).then((r) => { if (alive) setRecords(r.records); }).catch(() => {});
    poll();
    const id = setInterval(poll, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const groups = useMemo(() => groupByManuscriptModel(records ?? []), [records]);
  const loaded = records != null;

  return (
    <section className="mt-8">
      <h3 className="text-lg font-semibold">Analyzer throughput</h3>
      <p className="text-sm text-ink/60">
        Per-pass Ollama decode speed (eval tok/s), newest first — grouped by book &amp; model. Falling tok/s = slowing down.
      </p>
      {!loaded && <p className="text-sm text-ink/50">Loading telemetry…</p>}
      {loaded && groups.length === 0 && <p className="text-sm text-ink/50">No analyzer telemetry recorded yet.</p>}
      {loaded && groups.length > 0 && (
        <div data-testid="analyzer-trends-scroll" className="mt-3 max-h-[28rem] overflow-y-auto rounded-lg border border-ink/10">
          {groups.map((g) => (
            <div key={g.key} data-testid="analyzer-trends-section" className="border-b border-ink/10 p-3 last:border-b-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{g.bookTitle ?? g.manuscriptId}</span>
                <span className="text-xs text-ink/50">{g.model} · {g.rows.length} passes · avg {fmtTokS(g.avgTokS)}</span>
              </div>
              <TokSSparkline rows={g.rows} />
              <table className="mt-1 w-full text-xs">
                <thead>
                  <tr className="text-ink/50">
                    <th className="text-left font-medium">Ch</th>
                    <th className="text-left font-medium">Pass</th>
                    <th className="text-right font-medium">tok/s</th>
                    <th className="text-right font-medium">prompt t/s</th>
                    <th className="text-right font-medium">load</th>
                    <th className="text-right font-medium">calls</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r, i) => (
                    <AnalyzerRow key={`${r.at}:${r.chapterId}:${r.stage}`} row={r} newerTokS={g.rows[i - 1]?.evalTokS} />
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```

Supporting pure helpers (put near the component, mirroring `ResourceTrends`' local helpers):

```tsx
interface AnalyzerGroup { key: string; manuscriptId: string; model: string; bookTitle: string | null; rows: AnalyzerEvalRecord[]; avgTokS: number | null; }

/* Bucket by (manuscriptId, model) across the whole window (records arrive
   newest-first). Buckets ordered by most-recent row; rows kept newest-first. */
function groupByManuscriptModel(records: AnalyzerEvalRecord[]): AnalyzerGroup[] {
  const map = new Map<string, AnalyzerGroup>();
  for (const r of records) {
    const key = `${r.manuscriptId} ${r.model}`;
    let g = map.get(key);
    if (!g) { g = { key, manuscriptId: r.manuscriptId, model: r.model, bookTitle: r.bookTitle, rows: [], avgTokS: null }; map.set(key, g); }
    g.rows.push(r);
    if (g.bookTitle == null && r.bookTitle) g.bookTitle = r.bookTitle;
  }
  const groups = [...map.values()];
  for (const g of groups) {
    const vals = g.rows.map((r) => r.evalTokS).filter((v): v is number => v != null);
    g.avgTokS = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return groups; // insertion order = first-seen = newest-first bucket ordering
}

const fmtTokS = (v: number | null): string => (v == null ? '–' : `${v.toFixed(1)} t/s`);
const TREND_EPSILON = 0.5; // tok/s wobble to ignore

function AnalyzerRow({ row, newerTokS }: { row: AnalyzerEvalRecord; newerTokS?: number | null }) {
  // Falling tok/s vs the NEWER neighbour = deteriorating (rows are newest-first,
  // so "newer" is the row above). Load spike + failure get their own tint.
  const dropped = row.evalTokS != null && newerTokS != null && newerTokS < row.evalTokS - TREND_EPSILON;
  const loadSpike = row.loadMs > 200;
  return (
    <tr className={row.outcome === 'failed' ? 'text-magenta' : undefined} data-testid="analyzer-trends-row">
      <td>{row.chapterId}</td>
      <td>{row.stage}{row.chunkCount && row.chunkCount > 1 ? ` ⑂${row.chunkCount}` : ''}</td>
      <td className={`text-right ${dropped ? 'text-magenta' : ''}`}>{fmtTokS(row.evalTokS)}{dropped ? ' ▼' : ''}</td>
      <td className="text-right">{row.promptTokS == null ? '–' : row.promptTokS.toFixed(0)}</td>
      <td className={`text-right ${loadSpike ? 'text-magenta' : ''}`}>{Math.round(row.loadMs)}</td>
      <td className="text-right">{row.subCalls}</td>
    </tr>
  );
}

function TokSSparkline({ rows }: { rows: AnalyzerEvalRecord[] }) {
  const series = rows.map((r) => r.evalTokS).filter((v): v is number => v != null).reverse(); // oldest→newest
  if (series.length < 2) return null;
  const max = Math.max(...series), min = Math.min(...series), span = max - min || 1;
  const pts = series.map((v, i) => `${(i / (series.length - 1)) * 260},${28 - ((v - min) / span) * 24}`).join(' ');
  return (
    <svg width="100%" height="30" viewBox="0 0 260 30" preserveAspectRatio="none" data-testid="analyzer-toks-sparkline" aria-label={`tok/s trend across ${series.length} passes`}>
      <polyline fill="none" stroke="currentColor" strokeWidth="1.6" points={pts} className="text-magenta" />
    </svg>
  );
}
```

Add imports at the top of `admin.tsx`: `useMemo` (if not already), and `AnalyzerEvalRecord` from `../lib/api` (or `../lib/types`). Mount `<AnalyzerTrends />` immediately after `<ResourceTrends />`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/views/admin.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/admin.tsx src/views/admin.test.tsx
git commit -m "feat(frontend): AnalyzerTrends admin panel (tok/s trend by book+model)"
```

---

### Task 7: Regression plan, release notes, backlog link, verify

**Files:**
- Create: `docs/features/<n>-analyzer-eval-rate-telemetry.md` (from `docs/features/TEMPLATE.md`)
- Modify: `docs/features/INDEX.md`
- Modify: `docs/release-notes-next.md` (technical register) + `RELEASE_NOTES.md` (brand-voice line)
- Modify: `docs/BACKLOG.md` (thin row) + file the GitHub `srv-` issue

- [ ] **Step 1: Regression plan doc** — copy `docs/features/TEMPLATE.md`, fill: invariants (token-weighted tok/s; per-(manuscript,chapter,pass) row; concurrency isolation; serialized append; group-by-key), the manual acceptance walkthrough (run a local analysis, open Admin → Analyzer throughput, confirm a section per book+model with a declining/steady sparkline; toggle `analyzer.evalStats.enabled` off → no new rows). Frontmatter `status: active`. Add its entry to `docs/features/INDEX.md`.

- [ ] **Step 2: Release notes (both files, same commit).**
  - `docs/release-notes-next.md`: `- **Analyzer throughput telemetry** — the Admin console now charts per-pass Ollama decode speed (tok/s) grouped by book + model, so analyzer speed drift across a long run is visible without grepping logs (#<issue>).`
  - `RELEASE_NOTES.md` (in-progress version section, brand voice): `- See how fast your local analyzer is really going: a new Admin panel tracks decode speed across a run and flags when it slows down.`

- [ ] **Step 3: File the backlog issue + row.** `gh issue create` titled `srv-<n> — analyzer eval-rate telemetry`, labels `type:feature`, `area:server`, `area:frontend` (set `moscow:` as appropriate). Add a thin row to `docs/BACKLOG.md` linking it. Put `Closes #<n>` in the eventual PR body.

- [ ] **Step 4: Full local verify.**

Run: `npm run typecheck && cd server && npx vitest run src/analyzer/analyzer-eval-stats.test.ts src/analyzer/ollama.test.ts src/routes/generation-stats.test.ts src/routes/analyzer-eval-wiring.test.ts && cd .. && npx vitest run src/views/admin.test.tsx && npm run config:check`
Expected: all PASS; `config:check` exits 0.

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs(analyzer): regression plan, release notes, backlog row for eval-rate telemetry"
```

---

## Self-review notes

- **Spec coverage:** capture seam (T2), pass-boundary emit incl. chunk/retry fold + failure + escalation-exclusion (T1+T3), serialized JSONL store + cap + newest-first (T1), env-gated registry knob (T2), API (T4), admin panel with key-grouping + bounded scroll + inverted trend + load/chunk hints (T6), all spec test cases (T1/T2/T4/T6). ✓
- **Concurrency invariant** is enforced structurally by `withPassEval` (fresh acc per call) and asserted by T1's "two concurrent passes on distinct calls" test. ✓
- **Type consistency:** `RawEvalTiming` / `AnalyzerEvalRecord` / `PassContext` / `withPassEval` signatures are identical across T1→T3→T5. Stage strings (`stage1-ch`/`stage2-ch`/`emotion`/`nonstory`/`review`/`stage3`) fixed in the T3 table and consumed as-is by the T6 table. ✓
- **Plan-review fixes folded in (adversarial pass):** Task 3's placebo test replaced with a **real guard** that imports `analysis.js` and drives the exported `attributeChapterStage2WithEval` wrapper (empty store if the wrap is dropped); the inline-per-chunk stage-1 cast `StageCall` (`analysis.ts:3190`) is explicitly **lifted to a named const** before wrapping, and the same lift-then-wrap is called out for emotion/review/stage3/nonstory.
- **Open (non-blocking):** loadMs threshold hard-coded 200 ms in `AnalyzerRow` (spec open-Q1); header uses mean (spec open-Q2); boolean-knob env coercion (`CASTWRIGHT_EVAL_SAMPLE=0`) to be confirmed against `qa.asr.enabled`'s behaviour during Task 2. All flagged for impl/tuning.
