# OpenAI-compatible analyzer — Wave 2 plan

> Part of the [OpenAI-compatible analyzer implementation plan](2026-09-11-openai-compatible-analyzer.md). Read that file first: its Global Constraints, planning decisions (P1–P11) and interface contract bind every task below. Spec: [2026-09-10-openai-compatible-analyzer-design.md](../specs/2026-09-10-openai-compatible-analyzer-design.md).

## Wave 2 — Capacity model, Gemini Auto max output tokens, Gemini thinking visibility, reasoning-overflow rule

Spec decisions 6 and 7, §6 and §7. Wave 1 (PRs 1a, 1b) is assumed merged. This file uses wave 1's contract names: `ChatTransport`, `TransportRequest`, `TransportResult`, `StageRunner`, `EngineRequestSettings`, `mapFinish`, `stripThink`, `GeminiTransport`, `OllamaTransport`, `withTransportRetry` and `TransportKind`.

Every `file:line` below is as of `origin/main` 2b63b451. Wave 0 (#3139 → PR #3163, #3141) and wave 1 both edit files cited here. Before each task, re-locate every anchor with `git grep -n` on the current `main`. Code that wave 1 moved is cited twice: its 2b63b451 location, and the wave-1 file it now lives in.

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

### PR 2a — Gemini thought-stream probe, chunk-budget pinning, capacity model

- **Branch:** `refactor/server-3084-w2a-capacity`. Create it with `node scripts/wt-new.mjs refactor/server-3084-w2a-capacity` off the latest `main`.
- **Delivers:**
  - An owner-run probe script and the run-sheet gate section that decides §7's branch.
  - A chunk-budget pinning fixture captured from unmodified code, plus its assertion.
  - `EngineCapacity` / `resolveCapacity` / `TODAY_LOCAL_CAPACITY` in `server/src/analyzer/capacity.ts`.
  - `resolveStage1ChunkCharBudget`, `resolveStage2ChunkCharBudget` and `chapterChunkBudget` taking a capacity instead of an engine name, with every caller updated.
- **Must NOT change:**
  - any chunk-budget value: the pinning fixture stays byte-identical after Task 2.2's commit;
  - any registry knob, its default or its `.env.example` line;
  - any request shape sent to Ollama or Gemini;
  - `maxOutputTokens` or the Gemini idle watchdog;
  - any failure-taxonomy outcome;
  - OpenAPI or any frontend file.
- **Entry criteria:**
  - PRs 1a and 1b, #3163 (#3139) and #3141's chain are merged to `main`.
  - #3196 (PR #3199, merge `839c65ac`) is merged to `main`. It makes `attribution-eval/run-eval.ts` pass its engine to `attributeChapterStage2`. Task 2.2's pinning capture must run on a `main` that includes it.
  - `rate-limit.ts`'s limit resolver has been re-read after #3163; its name and signature are what Task 2.3 exports.
- **Exit criteria:**
  - `capacity-pinning.test.ts` is green.
  - `git log --format=%H -- server/src/analyzer/__fixtures__/capacity-pinning.json` shows exactly one commit (Task 2.2's).
  - `npm run typecheck` and `npm run check:cycles` are green.
  - `npm run verify:fast:branch` is green.
  - The `pr-review-gate` pass has run at depth `high` (a `refactor` PR).
  - `npx tsx server/scripts/probe-gemini-thought-stream.ts` runs without a key and exits 2 with the "No Gemini API key" message.

### Task 2.1: Gemini thought-stream probe (owner-run gate) and run sheet

**Files:**
- Create: `server/src/analyzer/probe/thought-stream-summary.ts`
- Create: `server/scripts/probe-gemini-thought-stream.ts`
- Create: `docs/testing/3084-openai-analyzer-onbox-acceptance.md`
- Test: `server/src/analyzer/probe/thought-stream-summary.test.ts`

**Interfaces:**
- Consumes:
  - `getResolvedGeminiApiKey(): string | null` and `readUserSettings(): Promise<UserSettings>` (`server/src/workspace/user-settings.ts:830`, `:353`);
  - `resolveStreamIdleTimeoutMs(): number` (`server/src/analyzer/gemini.ts:73-78`; if wave 1 moved it, import it from the module `git grep -n "export function resolveStreamIdleTimeoutMs" server/src` names);
  - `GoogleGenAI.models.generateContentStream` with `config.thinkingConfig.includeThoughts` (`server/node_modules/@google/genai/dist/genai.d.ts:14395-14404`).
- Produces:
  - `summariseThoughtStream(events: ProbeChunkEvent[]): ThoughtStreamSummary`;
  - `decideThoughtStreamBranch(byModel: Record<string, ThoughtStreamSummary | { error: string }>, idleTimeoutMs: number): { branch: 'A' | 'B'; reason: string }`;
  - run sheet §1, whose recorded `Branch:` decides whether PR 2b executes Task 2.9A or Task 2.9B.

The script is under `server/scripts/`, like `sync-env-example.ts`, and runs with `npx tsx`. The pure summariser lives under `src/` so that vitest's `src/**/*.{test,spec}.ts` include (`server/vitest.config.ts:133`) covers it.

- [ ] **Step 1: Write the failing test**
```ts
/* #3084 wave 2 gate — pins the probe's summariser and its A/B decision rule.
   The rule is what the owner's recorded run sheet result is judged by, so a
   rule that silently waved a late burst through as "streams during thinking"
   would ship Branch A on a false premise. */
import { describe, it, expect } from 'vitest';
import {
  summariseThoughtStream,
  decideThoughtStreamBranch,
  GATE_MODEL,
  type ProbeChunkEvent,
  type ThoughtStreamSummary,
} from './thought-stream-summary.js';

const thought = (atMs: number): ProbeChunkEvent => ({ atMs, parts: [{ thought: true, text: '…' }] });
const answer = (atMs: number, extra: Partial<ProbeChunkEvent> = {}): ProbeChunkEvent => ({
  atMs,
  parts: [{ text: '{"count":' }],
  ...extra,
});

const streamingSummary = (): ThoughtStreamSummary =>
  summariseThoughtStream([
    thought(2_000),
    thought(9_000),
    thought(21_000),
    thought(33_000),
    answer(40_000),
    answer(41_000, { thoughtsTokenCount: 6_200, finishReason: 'STOP' }),
  ]);

describe('summariseThoughtStream', () => {
  it('times the first chunk, thought and answer part, counts thought parts before the answer, and tracks the longest pre-answer silence', () => {
    expect(streamingSummary()).toEqual({
      firstChunkMs: 2_000,
      firstThoughtMs: 2_000,
      firstAnswerMs: 40_000,
      thoughtPartsBeforeAnswer: 4,
      maxGapBeforeAnswerMs: 12_000,
      thoughtsTokenCount: 6_200,
      finishReason: 'STOP',
    });
  });

  it('counts the request-start → first-chunk wait as a gap', () => {
    const s = summariseThoughtStream([thought(50_000), answer(51_000)]);
    expect(s.maxGapBeforeAnswerMs).toBe(50_000);
  });

  it('reports nulls for a stream with no parts', () => {
    const s = summariseThoughtStream([]);
    expect(s).toEqual({
      firstChunkMs: null,
      firstThoughtMs: null,
      firstAnswerMs: null,
      thoughtPartsBeforeAnswer: 0,
      maxGapBeforeAnswerMs: 0,
      thoughtsTokenCount: null,
      finishReason: null,
    });
  });
});

describe('decideThoughtStreamBranch', () => {
  const IDLE = 45_000;

  it('A: thought parts spread across a long think, no silence reaching the watchdog', () => {
    expect(decideThoughtStreamBranch({ [GATE_MODEL]: streamingSummary() }, IDLE).branch).toBe('A');
  });

  it('B: thought parts arrive as a burst at the END of thinking', () => {
    const s = summariseThoughtStream([
      thought(29_000),
      thought(29_100),
      thought(29_200),
      answer(30_000, { thoughtsTokenCount: 4_000 }),
    ]);
    const v = decideThoughtStreamBranch({ [GATE_MODEL]: s }, IDLE);
    expect(v.branch).toBe('B');
    expect(v.reason).toContain('after half');
  });

  it('B: a pre-answer silence reaches the idle watchdog', () => {
    const s = summariseThoughtStream([
      thought(1_000),
      thought(3_000),
      thought(50_000),
      answer(120_000, { thoughtsTokenCount: 9_000 }),
    ]);
    expect(decideThoughtStreamBranch({ [GATE_MODEL]: s }, IDLE).branch).toBe('B');
  });

  it('B: no thinking reported', () => {
    const s = summariseThoughtStream([thought(1_000), thought(6_000), answer(12_000)]);
    expect(decideThoughtStreamBranch({ [GATE_MODEL]: s }, IDLE).branch).toBe('B');
  });

  it('B: thinking too short to tell streaming from a burst', () => {
    const s = summariseThoughtStream([thought(500), thought(1_000), answer(3_000, { thoughtsTokenCount: 300 })]);
    expect(decideThoughtStreamBranch({ [GATE_MODEL]: s }, IDLE).branch).toBe('B');
  });

  it('B: the gate model failed or was not probed', () => {
    expect(decideThoughtStreamBranch({ [GATE_MODEL]: { error: 'status=429' } }, IDLE).branch).toBe('B');
    expect(decideThoughtStreamBranch({}, IDLE).branch).toBe('B');
  });
});
```
- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/analyzer/probe/thought-stream-summary.test.ts`  Expected: FAIL with `Failed to resolve import "./thought-stream-summary.js"`
- [ ] **Step 3: Implement**

`server/src/analyzer/probe/thought-stream-summary.ts`:
```ts
/* #3084 wave 2 gate — pure summariser + branch rule for the owner-run Gemini
   thought-stream probe (server/scripts/probe-gemini-thought-stream.ts). It
   decides §7 of docs/superpowers/specs/2026-09-10-openai-compatible-analyzer-design.md:
     A — thought parts stream DURING thinking → keep the pre-first-chunk idle
         watchdog and rely on thought parts as stream activity;
     B — they don't (or the run can't tell) → arm the watchdog after the first
         chunk and bound the silent wait with analyzer.gemini.requestCeilingMs.
   B is safe whatever Gemini does, so every inconclusive outcome is B. No I/O. */

export const GATE_MODEL = 'gemini-3.6-flash';
/** Below this, a burst at the end of thinking is indistinguishable from streaming. */
export const MIN_THINKING_MS_FOR_A_VERDICT = 10_000;

export interface ProbePart {
  thought?: boolean;
  text?: string;
}

export interface ProbeChunkEvent {
  /** ms since the request was sent. */
  atMs: number;
  parts: ProbePart[];
  thoughtsTokenCount?: number;
  finishReason?: string;
}

export interface ThoughtStreamSummary {
  firstChunkMs: number | null;
  firstThoughtMs: number | null;
  firstAnswerMs: number | null;
  thoughtPartsBeforeAnswer: number;
  /** Longest silence before the first answer part: request start → first chunk,
      then chunk → chunk. Covers the whole stream when no answer arrived. */
  maxGapBeforeAnswerMs: number;
  thoughtsTokenCount: number | null;
  finishReason: string | null;
}

export function summariseThoughtStream(events: ProbeChunkEvent[]): ThoughtStreamSummary {
  let firstChunkMs: number | null = null;
  let firstThoughtMs: number | null = null;
  let firstAnswerMs: number | null = null;
  let thoughtPartsBeforeAnswer = 0;
  let maxGapBeforeAnswerMs = 0;
  let previousAtMs = 0;
  let thoughtsTokenCount: number | null = null;
  let finishReason: string | null = null;

  for (const ev of events) {
    if (firstChunkMs === null) firstChunkMs = ev.atMs;
    if (firstAnswerMs === null) {
      maxGapBeforeAnswerMs = Math.max(maxGapBeforeAnswerMs, ev.atMs - previousAtMs);
    }
    previousAtMs = ev.atMs;
    for (const part of ev.parts) {
      if (part.thought === true) {
        if (firstThoughtMs === null) firstThoughtMs = ev.atMs;
        if (firstAnswerMs === null) thoughtPartsBeforeAnswer += 1;
      } else if (typeof part.text === 'string' && part.text.length > 0 && firstAnswerMs === null) {
        firstAnswerMs = ev.atMs;
      }
    }
    if (typeof ev.thoughtsTokenCount === 'number') thoughtsTokenCount = ev.thoughtsTokenCount;
    if (ev.finishReason) finishReason = ev.finishReason;
  }

  return {
    firstChunkMs,
    firstThoughtMs,
    firstAnswerMs,
    thoughtPartsBeforeAnswer,
    maxGapBeforeAnswerMs,
    thoughtsTokenCount,
    finishReason,
  };
}

export function decideThoughtStreamBranch(
  byModel: Record<string, ThoughtStreamSummary | { error: string }>,
  idleTimeoutMs: number,
): { branch: 'A' | 'B'; reason: string } {
  const s = byModel[GATE_MODEL];
  if (!s || 'error' in s) return { branch: 'B', reason: `${GATE_MODEL} probe did not complete` };
  if (!s.thoughtsTokenCount) {
    return { branch: 'B', reason: `${GATE_MODEL} reported no thoughtsTokenCount — thinking was not observed` };
  }
  if (s.firstAnswerMs === null) return { branch: 'B', reason: 'no answer part arrived' };
  if (s.firstAnswerMs < MIN_THINKING_MS_FOR_A_VERDICT) {
    return {
      branch: 'B',
      reason: `answer began after ${s.firstAnswerMs} ms — too short to tell streaming from a burst`,
    };
  }
  if (s.firstThoughtMs === null || s.thoughtPartsBeforeAnswer < 2) {
    return { branch: 'B', reason: `${s.thoughtPartsBeforeAnswer} thought part(s) arrived before the answer` };
  }
  if (s.firstThoughtMs > s.firstAnswerMs / 2) {
    return {
      branch: 'B',
      reason: `first thought part at ${s.firstThoughtMs} ms, after half of the ${s.firstAnswerMs} ms thinking phase`,
    };
  }
  if (s.maxGapBeforeAnswerMs >= idleTimeoutMs) {
    return {
      branch: 'B',
      reason: `a ${s.maxGapBeforeAnswerMs} ms silence before the answer reaches the ${idleTimeoutMs} ms idle watchdog`,
    };
  }
  return {
    branch: 'A',
    reason: `${s.thoughtPartsBeforeAnswer} thought parts streamed from ${s.firstThoughtMs} ms; longest pre-answer silence ${s.maxGapBeforeAnswerMs} ms`,
  };
}
```

`server/scripts/probe-gemini-thought-stream.ts`:
```ts
/* #3084 wave 2 gate — OWNER-RUN probe. Answers one fact the design could not
   settle from documentation: does Gemini stream thought parts (includeThoughts)
   DURING thinking, or only once thinking ends? Run from the repository root:

     npx tsx server/scripts/probe-gemini-thought-stream.ts

   Sends exactly three streaming requests — one per model below — and prints,
   per model: ms to first chunk, ms to first thought part, ms to first answer
   part, thought parts before the first answer part, thoughtsTokenCount,
   finishReason, and the longest pre-answer silence. The last line is the A/B
   verdict (decideThoughtStreamBranch). Record the output in
   docs/testing/3084-openai-analyzer-onbox-acceptance.md §1.

   The API key is never printed: only its source is, and every error message is
   scrubbed of the key before printing. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ProbeChunkEvent,
  ThoughtStreamSummary,
} from '../src/analyzer/probe/thought-stream-summary.js';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/* The server runs with its cwd at server/, and server/.env's WORKSPACE_DIR is
   relative to it. Match that before any workspace module captures env. */
process.chdir(serverDir);
try {
  process.loadEnvFile(resolve(serverDir, '.env'));
} catch {
  /* No server/.env: the shell env and the saved settings key still apply. */
}

const { GoogleGenAI } = await import('@google/genai');
const { readUserSettings, getResolvedGeminiApiKey } = await import('../src/workspace/user-settings.js');
const { summariseThoughtStream, decideThoughtStreamBranch } = await import(
  '../src/analyzer/probe/thought-stream-summary.js'
);
const { resolveStreamIdleTimeoutMs } = await import('../src/analyzer/gemini.js');

const envKey = process.env.GEMINI_API_KEY?.trim();
if (!envKey) await readUserSettings();
const apiKey = getResolvedGeminiApiKey();
if (!apiKey) {
  console.error('[probe] No Gemini API key: set GEMINI_API_KEY in server/.env or save one in Account settings.');
  process.exit(2);
}
const keySource = envKey ? 'GEMINI_API_KEY (server/.env or shell)' : 'saved user settings';
const redact = (text: string): string => text.split(apiKey).join('<redacted>');

const MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemma-4-31b-it'] as const;
const PROMPT = [
  'Think carefully before answering.',
  'Count the positive integers n with 1 <= n <= 3000 such that n, n+1 and n+2 each have exactly four positive divisors.',
  'Check every candidate you rely on.',
  'Reply with only the JSON object {"count": <integer>}.',
].join('\n');

const idleTimeoutMs = resolveStreamIdleTimeoutMs();
const client = new GoogleGenAI({ apiKey });
const results: Record<string, ThoughtStreamSummary | { error: string }> = {};

console.log(`[probe] key source: ${keySource}; idle watchdog ${idleTimeoutMs} ms; ${MODELS.length} requests`);

for (const model of MODELS) {
  const events: ProbeChunkEvent[] = [];
  const startedAt = Date.now();
  try {
    const stream = await client.models.generateContentStream({
      model,
      contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
      config: { thinkingConfig: { includeThoughts: true }, temperature: 0.2 },
    });
    for await (const chunk of stream) {
      const candidate = chunk.candidates?.[0];
      events.push({
        atMs: Date.now() - startedAt,
        parts: (candidate?.content?.parts ?? []).map((p) => ({ thought: p.thought, text: p.text })),
        thoughtsTokenCount: chunk.usageMetadata?.thoughtsTokenCount,
        finishReason: candidate?.finishReason,
      });
    }
    const summary = summariseThoughtStream(events);
    results[model] = summary;
    console.log(`[probe] ${model} ${JSON.stringify({ ...summary, chunks: events.length })}`);
  } catch (err) {
    const status = (err as { status?: number }).status;
    const message = redact((err as Error)?.message ?? String(err)).slice(0, 400);
    results[model] = { error: `status=${status ?? 'n/a'} ${message}` };
    console.log(`[probe] ${model} FAILED status=${status ?? 'n/a'} ${message}`);
  }
}

const verdict = decideThoughtStreamBranch(results, idleTimeoutMs);
console.log(`[probe] branch ${verdict.branch}: ${verdict.reason}`);
```

`docs/testing/3084-openai-analyzer-onbox-acceptance.md`:
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

## 1. Wave 2 gate — do Gemini thought summaries stream during thinking?

**Not a register row.** This is a planning fact that the design could not
settle from documentation (spec, "Verifications owed during planning" →
Gemini, first bullet). **PR 2b cannot merge until the `Result:` and `Branch:`
lines below are filled in.**

**Why it matters.** Wave 2 raises Gemini's default output cap from 8192 to the
model's own limit (Auto). A thinking model may then think for minutes before
its first answer token. Gemini's idle watchdog (45 s) is armed before the first
chunk, so it would kill that request unless something arrives during thinking:

- **Branch A.** Thought summaries stream while the model thinks, and they keep
  the watchdog alive.
- **Branch B.** They do not. The watchdog then waits for the first chunk, and a
  request ceiling (`analyzer.gemini.requestCeilingMs`, 30 min) bounds the wait
  instead.

### Preconditions

- [ ] A Gemini API key: `GEMINI_API_KEY` in `server/.env`, **or** saved in
      Account settings. The probe prints only where the key came from, never
      the key.
- [ ] Quota for 3 requests: one each on `gemini-3.6-flash` (20 requests a day),
      `gemini-3.5-flash-lite` and `gemma-4-31b-it`.
- [ ] Run from the primary checkout. It holds `server/.env` and the saved key;
      worktrees carry no secrets.

### Procedure

1. From the repository root: `npx tsx server/scripts/probe-gemini-thought-stream.ts`
2. Paste every `[probe]` line into `Result:` below, unedited.
3. Copy the last line's letter into `Branch:`.

### Decision rule

The rule is implemented in `decideThoughtStreamBranch`
(`server/src/analyzer/probe/thought-stream-summary.ts`) and pinned by its
test. The outcome is **Branch A** only if all of the following hold for
`gemini-3.6-flash`:

- `thoughtsTokenCount` is greater than 0;
- the first answer part arrives 10 s or more after the request;
- 2 or more thought parts arrive before the first answer part;
- the first thought part arrives in the first half of that pre-answer period;
- no silence before the answer reaches the 45 s idle watchdog.

Anything else — including a failed request — is **Branch B**.

### Result

Result:

Branch:

Run by / date / SHA:
```
- [ ] **Step 4: Run and confirm it passes**
Run: `npm --prefix server run test -- src/analyzer/probe/thought-stream-summary.test.ts`  Expected: PASS (9 tests).

Also check that the script loads and refuses without a key. Run it from a shell with `GEMINI_API_KEY` removed, in a worktree with no saved key: `Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue; npx tsx server/scripts/probe-gemini-thought-stream.ts`. Expected: exit code 2 and `[probe] No Gemini API key: …`.
- [ ] **Step 5: Mutation proof**
  1. In `thought-stream-summary.ts`, change `if (s.firstThoughtMs > s.firstAnswerMs / 2) {` to `if (false) {`.
  2. Run the Step 4 command. Expected red: `decideThoughtStreamBranch > B: thought parts arrive as a burst at the END of thinking`.
  3. Restore the line, and re-run to green.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/probe/thought-stream-summary.ts server/src/analyzer/probe/thought-stream-summary.test.ts server/scripts/probe-gemini-thought-stream.ts docs/testing/3084-openai-analyzer-onbox-acceptance.md
git commit -m "chore(server,docs): add Gemini thought-stream probe and #3084 run sheet"
```

**Tests this task could break:** none; every file is new.

**Owner hand-off:** once this commit exists (on the branch or on `main`), the owner runs run sheet §1 in the primary checkout. The result is recorded by a commit that edits only `docs/testing/3084-openai-analyzer-onbox-acceptance.md` §1: in PR 2a if the run happens before 2a merges, otherwise as PR 2b's first commit.

### Task 2.2: Chunk-budget pinning fixture, captured from unmodified code

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
  - the single adapter function `computeBudget(c, body)`, which Task 2.4 re-points at the capacity signatures without touching the fixture.

Case matrix:
- **Engines.** `local-qwen3.5:4b@32768` (`ANALYZER_NUM_CTX=32768`); `gemini-3.5-flash-lite@12000` (`ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST=12000`); and, only if Step 1's caller grep finds a production caller that passes no engine, `unset` (today's `engine === undefined` path). Since PR #3199, `attribution-eval/run-eval.ts` passes its engine, so the expected matrix has no `unset` column.
- **Scripts.** Chapter One of `server/src/__fixtures__/the-coalfall-commission.md` (Latin), `.ru.md` (Cyrillic), `.zh.md` (Han) and `.ja.md` (kana + kanji).
- **Resolvers, each as the real callers pass it:**
  - stage 1 without a roster, and with a 40-entry roster (`routes/analysis.ts:4410-4418`, `:6926-6931`);
  - stage 2 (`analysis.ts:2308`);
  - `chapterChunkBudget(engine, 0, body, OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS)`, the emotion and instruct passes (`annotate-emotion.ts:178-183`, `instruct-annotation.ts:177-182`);
  - `chapterChunkBudget(engine, JSON.stringify(roster).length + 800, body, OUTPUT_HEAVY_CLOUD_RESERVED_TOKENS)`, script review (`script-review.ts:822-827`, `attribution-eval/review-run.ts:60-65`);
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
Read each call's arguments. On 2b63b451 plus PR #3199, every production caller passes an engine:
- `routes/analysis.ts` stage 1 (`:4410`, `:6926`, `selection.engine`);
- both `attributeChapterStage2WithEval` calls (`engine: phase1Selection.engine`, `:5375`, `:7221`);
- the `chapterChunkBudget` passes (`annotate-emotion.ts:178`, `instruct-annotation.ts:177`, `script-review.ts:822`, `attribution-eval/review-run.ts:60`);
- `attribution-eval/run-eval.ts`.

Only test files call `attributeChapterStage2` without one. Choose by the grep:
- **No production caller omits the engine** (the expected result): keep `unset` out of `ENGINES`, as written below, and the fixture has 42 cases. The `undefined`-capacity branch that Task 2.4 keeps (`capacity?.family !== 'context'`) is then reached only from the test suites Task 2.4 Step 4 runs.
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

/* ── The ONLY part of this file Task 2.4 changes. ─────────────────────────── */
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

### Task 2.3: `EngineCapacity` and `resolveCapacity`

**Files:**
- Create: `server/src/analyzer/capacity.ts`
- Modify: `server/src/analyzer/rate-limit.ts:76` (export the limit resolver; re-read after #3163 — `resolveLimits` at 2b63b451)
- Test: `server/src/analyzer/capacity.test.ts`

**Interfaces:**
- Consumes:
  - `configValue<number>('analyzer.ollama.numCtx')` (the same read as `resolveAnalyzerNumCtx`, `ollama.ts:275-277`; `capacity.ts` must not import `ollama.ts`, because wave 2b's Ollama settings provider imports `capacity.ts`);
  - `resolveMaxInputTokensPerRequest()` (`token-budget.ts:30-32`);
  - `resolveLimits(model: string): { rpm: number; tpm: number; rpd: number }` (`rate-limit.ts:76-84`, now exported).
- Produces, per the contract:
  - `export interface EngineCapacity { family: 'context' | 'requestCap'; contextTokens: number; maxOutputTokens: number | null; perRequestInputCap?: number }`;
  - `export function resolveCapacity(sel: { engine: 'local' | 'gemini'; model: string }): EngineCapacity`. Wave 3 widens `engine` to `AnalysisEngine` and adds `endpoint?: AnalyzerEndpoint`;
  - `export const TODAY_LOCAL_CAPACITY: (numCtx?: number) => EngineCapacity`;
  - `export const GEMINI_FALLBACK_MAX_OUTPUT_TOKENS = 8192`.

**TPM check (spec §6).** `perRequestInputCap = min(analyzer.gemini.maxInputTokensPerRequest, model TPM)`. Every `BUILTIN_LIMITS` TPM (`rate-limit.ts:39-48`) is at least 12000: the eight models are 250000 ×6 and 16000 ×2 (gemma). `FALLBACK_LIMITS.tpm` is 100000 (`:33`). So at the default cap the minimum is always 12000, and no pinned value changes. It binds only when an operator sets `GEMINI_TPM_<SLUG>` below the cap (or, after #3163, a Settings override below it). The budget then shrinks to fit TPM, which test 4 below pins.

- [ ] **Step 1: Write the failing test**
```ts
/* #3084 wave 2 — EngineCapacity resolution (spec §6). Ollama: context family,
   num_ctx as sent, no /api/show clamp. Gemini: request-cap family,
   perRequestInputCap = min(maxInputTokensPerRequest, model TPM). */
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

  it('every built-in model keeps the 12000 cap — no built-in TPM is below it, so no pinned budget moves', () => {
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

  it('a model TPM below the cap binds (min, not the cap alone)', () => {
    process.env.GEMINI_TPM_GEMINI_3_5_FLASH_LITE = '8000';
    expect(resolveCapacity({ engine: 'gemini', model: 'gemini-3.5-flash-lite' }).perRequestInputCap).toBe(8000);
  });

  it('an unlimited TPM leaves the cap in charge', () => {
    process.env.GEMINI_TPM_GEMINI_3_5_FLASH_LITE = 'unlimited';
    expect(resolveCapacity({ engine: 'gemini', model: 'gemini-3.5-flash-lite' }).perRequestInputCap).toBe(12000);
  });

  it('follows analyzer.gemini.maxInputTokensPerRequest', () => {
    process.env.ANALYZER_MAX_INPUT_TOKENS_PER_REQUEST = '6000';
    expect(resolveCapacity({ engine: 'gemini', model: 'gemini-3.5-flash-lite' }).perRequestInputCap).toBe(6000);
  });
});
```
- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/analyzer/capacity.test.ts`  Expected: FAIL with `Failed to resolve import "./capacity.js"`
- [ ] **Step 3: Implement**

`server/src/analyzer/rate-limit.ts:76`: change `function resolveLimits(model: string): ModelLimits {` to `export function resolveLimits(model: string): ModelLimits {`. If #3163 renamed or re-signatured it, export that resolver and use its name below; record the name in the PR body.

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
   Ollama's contextTokens is num_ctx AS SENT — deliberately not clamped to
   /api/show's native context before on-box measurement (register row
   "Capacity recalibration"). Endpoints (context family + optional cap) arrive
   in wave 3. Must not import ollama.ts: ollama.ts's settings provider imports
   this module. */
import { configValue } from '../config/resolver.js';
import { resolveLimits } from './rate-limit.js';
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
    perRequestInputCap: Math.min(cap, resolveLimits(sel.model).tpm),
  };
}
```
- [ ] **Step 4: Run and confirm it passes**
Run: `npm --prefix server run test -- src/analyzer/capacity.test.ts src/analyzer/rate-limit.test.ts`  Expected: PASS. Then run `npm run check:cycles`: PASS, with no new cycle.
- [ ] **Step 5: Mutation proof**
  1. In `capacity.ts`, replace `perRequestInputCap: Math.min(cap, resolveLimits(sel.model).tpm),` with `perRequestInputCap: cap,`.
  2. Expected red: `resolveCapacity — Gemini > a model TPM below the cap binds (min, not the cap alone)`.
  3. Restore it and re-run to green.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/capacity.ts server/src/analyzer/capacity.test.ts server/src/analyzer/rate-limit.ts
git commit -m "refactor(server): add EngineCapacity and resolveCapacity (#3084)"
```

**Tests this task could break:** `src/analyzer/rate-limit.test.ts` (export only).

### Task 2.4: Chunk-budget resolvers take an `EngineCapacity`

**Files:**
- Modify: `server/src/analyzer/token-budget.ts:47-51` — `cloudBodyCharBudget` gains an optional cap.
- Modify: `server/src/analyzer/stage1-chunk.ts:95-125`
- Modify: `server/src/analyzer/stage2-chunk.ts:70-82`
- Modify: `server/src/analyzer/chapter-chunker.ts:130-139`
- Modify: `server/src/config/registry.ts:129` — the comment names `chapterChunkBudget('gemini')`, which no longer exists.
- Modify: `server/src/routes/analysis.ts:12` (import), `:2208-2212`, `:2308`, `:4410-4411`, `:5375`, `:6926-6927`, `:7221`
- Modify: `server/src/routes/annotate-emotion.ts:178-179` (+ import)
- Modify: `server/src/routes/instruct-annotation.ts:177-178` (+ import)
- Modify: `server/src/routes/script-review.ts:822-823` (+ import)
- Modify: `server/src/analyzer/attribution-eval/review-run.ts:47`, `:56`, `:60-61`
- Modify: `server/src/analyzer/attribution-eval/run-eval.ts` — the `chunkEngine` declaration and its two uses as PR #3199 left them (locate with `git grep -n chunkEngine server/src/analyzer/attribution-eval/run-eval.ts`)
- Test (modify):
  - `server/src/analyzer/capacity-pinning.test.ts` (the `computeBudget` block only);
  - `server/src/analyzer/chapter-chunker.test.ts:9-52`;
  - `server/src/analyzer/stage1-chunk.test.ts:136-141`, `:197`, `:234-235`;
  - `server/src/analyzer/stage2-chunk.test.ts:160-165`, `:195-217`;
  - `server/src/analyzer/output-heavy-tpm.test.ts:95-100`, `:121-125`, `:151-156`, `:177-179`;
  - `server/src/analyzer/attribution-eval/review-run.test.ts:55-60`, `:116`, `:144`, `:162`, `:205`, `:236`, `:299`, `:338`;
  - `server/src/analyzer/attribution-eval/run-eval.test.ts` — PR #3199's `engine parameter mapping to attributeChapterStage2` describe.

**Interfaces:**
- Consumes: `EngineCapacity`, `resolveCapacity`, `TODAY_LOCAL_CAPACITY` (Task 2.3).
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
/* ── The ONLY part of this file Task 2.4 changes. ─────────────────────────── */
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
- **Constant.** Add `const GEMMA = () => resolveCapacity({ engine: 'gemini', model: 'gemma-4-31b-it' });` after line 48. This is the Gemma TPM story these locks guard: min(12000, 16000) = 12000.
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

`server/src/analyzer/attribution-eval/run-eval.ts`, as PR #3199 left it. That PR moved `chunkEngine` above the `attributeChapterStage2({ … })` call, and it now feeds both that call and the review call:
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
git diff --exit-code -- server/src/analyzer/__fixtures__/capacity-pinning.json
```
Expected: all PASS, and the fixture shows no diff.
- [ ] **Step 5: Mutation proof**
  1. In `stage1-chunk.ts`, change `if (capacity?.family !== 'context') {` to `if (capacity === undefined) {`.
  2. Run `npm --prefix server run test -- src/analyzer/capacity-pinning.test.ts`. Expected red: `… every resolver × engine × script equals the fixture captured from main` (`stage1|gemini-3.5-flash-lite@12000|*` now takes the context branch with `contextTokens` 12000).
  3. Restore it.
  4. In `chapter-chunker.ts`, drop the fourth argument `capacity.perRequestInputCap`. Expected red: `chapterChunkBudget … > a request-cap capacity sizes the body to ITS perRequestInputCap`.
  5. Restore it.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/token-budget.ts server/src/analyzer/stage1-chunk.ts server/src/analyzer/stage2-chunk.ts server/src/analyzer/chapter-chunker.ts server/src/config/registry.ts server/src/routes/analysis.ts server/src/routes/annotate-emotion.ts server/src/routes/instruct-annotation.ts server/src/routes/script-review.ts server/src/analyzer/attribution-eval/review-run.ts server/src/analyzer/attribution-eval/run-eval.ts server/src/analyzer/attribution-eval/run-eval.test.ts server/src/analyzer/capacity-pinning.test.ts server/src/analyzer/chapter-chunker.test.ts server/src/analyzer/stage1-chunk.test.ts server/src/analyzer/stage2-chunk.test.ts server/src/analyzer/output-heavy-tpm.test.ts server/src/analyzer/attribution-eval/review-run.test.ts
git commit -m "refactor(server): size analyzer chunk budgets from EngineCapacity (#3084)"
```

**Tests this task could break (all run in Step 4):**
- the chunk suites listed in Files;
- `token-budget.test.ts`;
- the `attribution-eval/*` suites, including PR #3199's `run-eval.test.ts` engine-mapping cases (updated in Step 1);
- the three passes' route tests (`annotate-emotion.test.ts:257`, `instruct-annotation.test.ts:302` and `script-review.test.ts:607`, which force a small `num_ctx`);
- the `attributeChapterStage2` suites (`analysis.test.ts:8290-8370`, `analysis.structure-engine.test.ts`, `analysis.structure-fixture.test.ts`; none pass `engine`, so they compile unchanged);
- slow `analysis-pipelining.test.ts`.

### Task 2.5: Ship PR 2a

**Files:**
- Modify (only if the owner has run it): `docs/testing/3084-openai-analyzer-onbox-acceptance.md` §1.

- [ ] **Step 1: Derived artifacts.**
  - OpenAPI is untouched: no regen.
  - No knob is added or changed, so there is no `config:sync`. Confirm with `npm run config:check` (PASS; the registry diff is a comment only).
- [ ] **Step 2: Release notes** — skipped, with this reason stated in the PR body: *no shippable delta. The budget refactor is behaviour-preserving (pinned by `capacity-pinning.test.ts`); the probe is an owner-run dev script; the run sheet is docs.*
- [ ] **Step 3: On-box acceptance** — not applicable. PR 2a ships no behaviour that needs hardware to prove. Run sheet §1 is a planning gate, not a register row; the wave 2 rows ship in PR 2b.
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
- `EngineCapacity` / `resolveCapacity` (`server/src/analyzer/capacity.ts`): Ollama is the context family (`num_ctx` as sent, no `/api/show` clamp); Gemini is the request-cap family, with `perRequestInputCap = min(analyzer.gemini.maxInputTokensPerRequest, model TPM)`. No built-in TPM is below 12000, so no default budget moves; a `GEMINI_TPM_<SLUG>` env below the cap now shrinks the body budget to fit it.
- `resolveStage1ChunkCharBudget`, `resolveStage2ChunkCharBudget` and `chapterChunkBudget` take a capacity instead of an engine name, and every caller is updated (analysis, annotate-emotion, instruct-annotation, script-review, attribution eval).
- A pinning fixture captured from unmodified `main`, which includes PR #3199. It has 42 cases: stage 1 ± roster, stage 2 and three `chapterChunkBudget` shapes, × local `qwen3.5:4b`@32768 / `gemini-3.5-flash-lite`@12000, × Coalfall Latin, Cyrillic, Han, kana. It has 54 cases, with an `unset` column, only if Task 2.2's caller grep found a production caller that passes no engine. State which case applies, and paste the grep output. The fixture is committed before the refactor and unchanged after it.
- An owner-run probe (`npx tsx server/scripts/probe-gemini-thought-stream.ts`) plus run sheet §1, which decides wave 2b's Branch A / B.

Also fixed, found in passing: `registry.ts:129` and `chapter-chunker.ts:116-117` comments named the removed engine argument.

Release notes: skipped — no shippable delta (behaviour-preserving refactor + dev script + docs).

## Test plan
- [ ] `capacity-pinning.test.ts` green; `git log -- server/src/analyzer/__fixtures__/capacity-pinning.json` shows one commit (capture SHA recorded in the fixture's `capturedFrom`)
- [ ] mutation proofs pasted (Tasks 2.1–2.4)
- [ ] `npm run typecheck`, `npm run check:cycles`, `npm run verify:fast:branch`

Refs #3084

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_013DFfsAoY1LtxjDgnGPSZkc
```
- [ ] **Step 7: Review gate.** Run the `pr-review-gate` skill at depth **high** (a `refactor` PR). Fold findings and re-run per the skill before merging.

---

### PR 2b — Gemini catalog, Auto max output tokens, thinking visibility, reasoning overflow

- **Branch:** `feat/server-3084-w2b-output-cap`. Create it with `node scripts/wt-new.mjs feat/server-3084-w2b-output-cap` off the latest `main`, after PR 2a merges.
- **Delivers:**
  - `server/src/analyzer/catalog/gemini-catalog.ts`: a 10-minute cached `models.list`, filtered per `02-gemini-facts.md` §3, and warmed before each stage call.
  - `analyzer.gemini.maxOutputTokens` defaulting to 0 = Auto (the model's `outputTokenLimit`, else 8192), with manual values clamped to the known limit. The runner passes the resolved cap to both transports.
  - Thinking Gemini models request `thinkingConfig.includeThoughts: true`. Thought parts feed the heartbeat, and `thoughtsTokenCount` becomes `usage.reasoningTokens`.
  - **Exactly one of:**
    - Task 2.9A — pins for the pre-first-chunk watchdog kept alive by thought parts;
    - Task 2.9B — watchdog armed after the first chunk, the `analyzer.gemini.requestCeilingMs` knob, `AnalyzerTimeoutError`, and FailureCode `analyzer-timeout`.

    Which one is decided by run sheet §1's recorded `Branch:`.
  - The reasoning-overflow rule in `runner/finish.ts`, plus FailureCode `analyzer-reasoning-overflow` in all six places.
  - On-box register rows "Thinking-model output" and "Capacity recalibration", with their run sheet sections and live view rows.
- **Must NOT change:**
  - any chunk budget (`capacity-pinning.test.ts` stays green, fixture untouched);
  - `analyzer.ollama.numPredict` or its semantics;
  - the Gemini structured-output mode (`json`), temperature, or either retry policy;
  - Gemini `thinkingLevel` / `thinkingBudget` (wave 5) and Ollama `think` (stays `false`);
  - anything endpoint-shaped (wave 3).
- **Entry criteria:**
  - PR 2a is merged.
  - Run sheet §1 on `main` (or PR 2b's first commit) has non-empty `Result:` and `Branch:` lines filled in by the owner.
  - The implementer reads `Branch:` and executes Task 2.9A if it is `A`, Task 2.9B if it is `B`, and never both.
- **Exit criteria:**
  - All task tests and the mutation proofs are green.
  - `npm run openapi:types` output is committed.
  - `npm run config:check` is green after `npm run config:sync`.
  - `npm run register:build -- --check` (if the script exposes `--check`; otherwise `npm run register:build` followed by `git diff --exit-code`) and `npm run check:onbox-register` are green, and the live view is published.
  - `npm run verify:fast:branch` is green.
  - `pr-review-gate` has run at depth `high` (the PR touches the server, openapi, frontend and docs scopes).
  - **A PR 2b missing run sheet §1's `Branch:` line is not mergeable**; the reviewer checks this.

### Task 2.6: Cached Gemini model catalog

**Files:**
- Create: `server/src/analyzer/catalog/gemini-catalog.ts`
- Test: `server/src/analyzer/catalog/gemini-catalog.test.ts`

**Interfaces:**
- Consumes:
  - `GoogleGenAI.models.list(): Promise<Pager<Model>>` (`genai.d.ts:11032`). `Pager` is `AsyncIterable` (`:11581`).
  - `Model.{name, displayName, inputTokenLimit, outputTokenLimit, supportedActions, thinking}` (`genai.d.ts:10790-10842`).
- Produces:
  - `export interface GeminiModelInfo { id: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; thinking?: boolean }` (contract)
  - `export async function listGeminiModels(apiKey: string, opts?: { refresh?: boolean; client?: GeminiModelsClient }): Promise<GeminiModelInfo[]>` (contract, plus a `client` injection seam; rejects on failure)
  - `export function getCachedGeminiModelInfo(model: string): GeminiModelInfo | undefined` (contract)
  - `export async function warmGeminiCatalog(apiKey: string, opts?: { client?: GeminiModelsClient }): Promise<void>` (never rejects; wave 2 uses it before each stage call)
  - `export function geminiModelThinks(model: string): boolean` (the catalog `thinking` flag, else the id rule)
  - `export function toGeminiModelInfo(m: GeminiListedModel): GeminiModelInfo | null`
  - `export type GeminiModelsClient = { models: { list: () => Promise<AsyncIterable<GeminiListedModel>> } }`
  - `export const GEMINI_CATALOG_TTL_MS = 600_000`
  - `export function _resetGeminiCatalogForTest(): void`

**Thinking id rule (used when the catalog has no entry):**
- `^gemini-(?:2\.5-(?:pro|flash)(?!-lite)|[3-9])`: Gemini 2.5 Pro and 2.5 Flash, and every Gemini 3.x+ model including Flash-Lite, count as thinking. `02-gemini-facts.md` §2: 3.x cannot turn thinking off, and "minimal does not guarantee thinking is off".
- 2.5 Flash-Lite does not think by default, so it is excluded.
- `gemma-*` counts as not thinking unless the catalog says `thinking: true`. Gemma 4 thinking defaults are unconfirmed (§2).

- [ ] **Step 1: Write the failing test**
```ts
/* #3084 wave 2b — Gemini model catalog: models.list filter (02-gemini-facts §3:
   no output-modality field, so supportedActions + name exclusions), 10-minute
   cache, key-change refetch, in-flight dedupe, failure swallowed by warm, and
   the thinking resolution (catalog flag first, id rule second). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  listGeminiModels,
  getCachedGeminiModelInfo,
  warmGeminiCatalog,
  geminiModelThinks,
  toGeminiModelInfo,
  GEMINI_CATALOG_TTL_MS,
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

function fakeClient(models: object[] = LISTED): GeminiModelsClient & { models: { list: ReturnType<typeof vi.fn> } } {
  return {
    models: {
      list: vi.fn(async () =>
        (async function* () {
          yield* models;
        })(),
      ),
    },
  } as unknown as GeminiModelsClient & { models: { list: ReturnType<typeof vi.fn> } };
}

beforeEach(() => _resetGeminiCatalogForTest());
afterEach(() => vi.restoreAllMocks());

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
});

describe('geminiModelThinks', () => {
  it('uses the id rule when the model is not listed', () => {
    expect(geminiModelThinks('gemini-3.6-flash')).toBe(true);
    expect(geminiModelThinks('gemini-3.5-flash-lite')).toBe(true);
    expect(geminiModelThinks('gemini-2.5-flash')).toBe(true);
    expect(geminiModelThinks('gemini-2.5-pro')).toBe(true);
    expect(geminiModelThinks('gemini-2.5-flash-lite')).toBe(false);
    expect(geminiModelThinks('gemma-4-31b-it')).toBe(false);
  });

  it('the catalog flag wins over the id rule in both directions', async () => {
    await listGeminiModels('k1', {
      client: fakeClient([
        { name: 'models/gemma-4-31b-it', supportedActions: ['generateContent'], thinking: true },
        { name: 'models/gemini-3.6-flash', supportedActions: ['generateContent'], thinking: false },
      ]),
    });
    expect(geminiModelThinks('gemma-4-31b-it')).toBe(true);
    expect(geminiModelThinks('gemini-3.6-flash')).toBe(false);
  });
});
```
- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/analyzer/catalog/gemini-catalog.test.ts`  Expected: FAIL with `Failed to resolve import "./gemini-catalog.js"`
- [ ] **Step 3: Implement**
```ts
/* #3084 wave 2b — cached Gemini model catalog (spec §3, §6, §7).

   Feeds Auto max output tokens (outputTokenLimit), the capacity descriptor's
   context/output limits, and whether a model thinks (Model.thinking). Wave 3's
   GET /api/analyzer/models reuses listGeminiModels.

   Filter (02-gemini-facts §3): models.list carries no output-modality field, so
   keep supportedActions ∋ generateContent and drop ids naming a non-text
   modality or product (embedding, -tts, -image, -live, imagen, veo, aqa).

   Caching: one listing per API key per GEMINI_CATALOG_TTL_MS, keyed by a
   SHA-256 of the key (the raw key is never stored here). Concurrent callers
   share one request. getCachedGeminiModelInfo stays SYNCHRONOUS so
   resolveCapacity / resolveGeminiMaxOutputTokens never await — the transport
   warms the cache (warmGeminiCatalog) before the runner reads its settings.
   A failed listing leaves the cache as it was: callers fall back to today's
   values (12000-token cap, 8192 output). */
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
  models: { list: () => Promise<AsyncIterable<GeminiListedModel>> };
};

export const GEMINI_CATALOG_TTL_MS = 10 * 60 * 1000;
const FAILURE_BACKOFF_MS = 60 * 1000;
const EXCLUDED_ID = /embedding|-tts|-image|-live|imagen|veo|aqa/i;
const THINKING_ID_RULE = /^gemini-(?:2\.5-(?:pro|flash)(?!-lite)|[3-9])/;

interface CatalogState {
  keyHash: string;
  fetchedAt: number;
  models: GeminiModelInfo[];
}

let state: CatalogState | null = null;
let inFlight: { keyHash: string; promise: Promise<GeminiModelInfo[]> } | null = null;
let lastFailure: { keyHash: string; at: number } | null = null;
let warnedFailure = false;

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

export async function listGeminiModels(
  apiKey: string,
  opts: { refresh?: boolean; client?: GeminiModelsClient } = {},
): Promise<GeminiModelInfo[]> {
  const keyHash = hashKey(apiKey);
  if (
    !opts.refresh &&
    state &&
    state.keyHash === keyHash &&
    Date.now() - state.fetchedAt < GEMINI_CATALOG_TTL_MS
  ) {
    return state.models;
  }
  if (!opts.refresh && inFlight && inFlight.keyHash === keyHash) return inFlight.promise;

  const client = opts.client ?? (new GoogleGenAI({ apiKey }) as unknown as GeminiModelsClient);
  const promise = (async () => {
    const pager = await client.models.list();
    const models: GeminiModelInfo[] = [];
    for await (const listed of pager) {
      const info = toGeminiModelInfo(listed);
      if (info) models.push(info);
    }
    state = { keyHash, fetchedAt: Date.now(), models };
    lastFailure = null;
    return models;
  })();
  inFlight = { keyHash, promise };
  try {
    return await promise;
  } finally {
    if (inFlight?.promise === promise) inFlight = null;
  }
}

export function getCachedGeminiModelInfo(model: string): GeminiModelInfo | undefined {
  return state?.models.find((m) => m.id === model);
}

export async function warmGeminiCatalog(
  apiKey: string,
  opts: { client?: GeminiModelsClient } = {},
): Promise<void> {
  const keyHash = hashKey(apiKey);
  if (lastFailure && lastFailure.keyHash === keyHash && Date.now() - lastFailure.at < FAILURE_BACKOFF_MS) {
    return;
  }
  try {
    await listGeminiModels(apiKey, { client: opts.client });
  } catch (err) {
    lastFailure = { keyHash, at: Date.now() };
    if (!warnedFailure) {
      warnedFailure = true;
      const message = ((err as Error)?.message ?? String(err)).split(apiKey).join('<redacted>');
      console.warn(
        `[gemini-catalog] models.list failed — using fallback limits (12000-token cap, 8192 output): ${message}`,
      );
    }
  }
}

export function geminiModelThinks(model: string): boolean {
  return getCachedGeminiModelInfo(model)?.thinking ?? THINKING_ID_RULE.test(model);
}

export function _resetGeminiCatalogForTest(): void {
  state = null;
  inFlight = null;
  lastFailure = null;
  warnedFailure = false;
}
```
- [ ] **Step 4: Run and confirm it passes**
Run: `npm --prefix server run test -- src/analyzer/catalog/gemini-catalog.test.ts`  Expected: PASS (11 tests). Then run `npm run check:cycles`: PASS.
- [ ] **Step 5: Mutation proof**
  1. In `toGeminiModelInfo`, change `!(m.supportedActions ?? []).includes('generateContent')` to `false`. Expected red: `toGeminiModelInfo / listGeminiModels filter > keeps generateContent text models, strips models/, drops embedding/tts/image/live/aqa`. Restore it.
  2. Change `return getCachedGeminiModelInfo(model)?.thinking ?? THINKING_ID_RULE.test(model);` to `return THINKING_ID_RULE.test(model);`. Expected red: `geminiModelThinks > the catalog flag wins over the id rule in both directions`. Restore it.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/catalog/gemini-catalog.ts server/src/analyzer/catalog/gemini-catalog.test.ts
git commit -m "feat(server): cache the Gemini model catalog (#3084)"
```

**Tests this task could break:** none; the files are new.

### Task 2.7: `analyzer.gemini.maxOutputTokens` Auto, warmed before each stage call, passed to both transports

**Files:**
- Modify: `server/src/config/registry.ts:50-59` (the `analyzer.gemini.maxOutputTokens` knob)
- Modify: `server/src/analyzer/capacity.ts` (Gemini branch reads the catalog; add `resolveGeminiMaxOutputTokens`)
- Modify: `server/src/analyzer/runner/transport.ts`: `ChatTransport` gains an optional `prepare?(): Promise<void>`.
- Modify: `server/src/analyzer/runner/stage-runner.ts`: every `this.opts.settings()` read becomes `await this.resolveSettings()`. Find them with `git grep -n "settings()" server/src/analyzer/runner/stage-runner.ts`.
- Modify: `server/src/analyzer/transports/gemini-transport.ts`:
  - add `prepare()`;
  - the request `config.maxOutputTokens` reads `req.maxOutputTokens` (today `gemini.ts:732`).
- Modify: `server/src/analyzer/transports/ollama-transport.ts`: `options.num_predict` reads `req.maxOutputTokens` (today `ollama.ts:631-674`).
- Modify: `server/src/analyzer/gemini.ts`:
  - the `settings` provider passed to `new StageRunner` in `GeminiAnalyzer`'s constructor (wave 1; locate with `git grep -n "settings: () =>" server/src/analyzer`);
  - delete the orphaned `DEFAULT_MAX_OUTPUT_TOKENS` / `resolveMaxOutputTokens` (today `:80-91`) and fix the comment at `:62-64`.
- Modify: `server/src/analyzer/ollama.ts`: the `settings` provider in `OllamaAnalyzer`'s constructor.
- Modify: `server/.env.example:293` and `:301` (hand-written block outside the managed `BEGIN` marker at `:497`).
- Test (modify): `server/src/analyzer/capacity.test.ts`, `server/src/analyzer/gemini.test.ts:55-74` and `:773-780`, `server/src/analyzer/ollama.test.ts`

**Interfaces:**
- Consumes:
  - `getCachedGeminiModelInfo`, `warmGeminiCatalog`, `GeminiModelsClient` (Task 2.6);
  - `resolveNumPredict()` (`ollama.ts:289-294`);
  - `EngineRequestSettings.maxOutputTokens` and `TransportRequest.maxOutputTokens` (contract).
- Produces:
  - `export function resolveGeminiMaxOutputTokens(model: string): number` in `capacity.ts`;
  - `ChatTransport.prepare?(): Promise<void>` (a contract addition; see the final report);
  - `resolveCapacity({engine:'gemini'})` now returns `contextTokens = inputTokenLimit ?? cap` and `maxOutputTokens = outputTokenLimit ?? 8192`. `perRequestInputCap` is unchanged, so the pinning stays green.

**Semantics (spec §7):**
- **`0` (the new default).** Auto: the listed `outputTokenLimit`, else `8192`.
- **An explicit value** (env `ANALYZER_MAX_OUTPUT_TOKENS` or a Settings override) keeps its meaning, clamped to the listed limit when that is known.
- **Maximum.** Lifted to `1_048_576`, the largest listed Gemini context. The effective ceiling is the model's own limit, via the clamp.
- **Existing configurations.**
  - An env value of `0` used to be rejected (`< 256`, `resolver.ts:197`) and fell through to 8192; it now means Auto.
  - Values 1–255, which used to be rejected, are now accepted as written.
- **Ollama.** `analyzer.ollama.numPredict` is unchanged; the runner now carries its resolved value (`-1` = unlimited) in `TransportRequest.maxOutputTokens`.

- [ ] **Step 1: Write the failing test**

Append to `server/src/analyzer/capacity.test.ts` (merge into its import lines):
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

In `server/src/analyzer/gemini.test.ts` (re-locate the mock block after wave 1; at 2b63b451 it is `:55-74`), replace lines 55-63 with:
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

Append to `server/src/analyzer/ollama.test.ts`, which uses the file's existing `fetchMock`, `okResponse`, `ndjsonStream`, `chunksOf` and `VALID_RESPONSE` helpers. If wave 1 moved the body-shape test at `:228-275`, place this block next to it:
```ts
describe('OllamaAnalyzer — the resolved output cap reaches the wire (#3084 wave 2b)', () => {
  afterEach(() => {
    delete process.env.ANALYZER_NUM_PREDICT;
  });
  afterAll(async () => {
    await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_ollama_num_predict-stage1-ch1.md'), { force: true });
    await rm(resolve(HANDOFF_ROOT, 'outbox', 'm_ollama_num_predict-stage1-ch1.json'), { force: true });
  });

  it('sends options.num_predict from the runner-resolved maxOutputTokens (ANALYZER_NUM_PREDICT=4096)', async () => {
    process.env.ANALYZER_NUM_PREDICT = '4096';
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
npm --prefix server run test -- src/analyzer/capacity.test.ts
npm --prefix server run test:slow -- src/analyzer/gemini.test.ts
```
Expected FAIL:
- `capacity.test.ts` with `resolveGeminiMaxOutputTokens is not a function`, plus `…knob > defaults to 0 = Auto…` (received `min: 256, max: 32768, default: 8192`);
- `gemini.test.ts` `… the listed outputTokenLimit — the catalog is warmed BEFORE the request is built` (`listModels` called 0 times; `maxOutputTokens` 8192).

`ollama.test.ts`'s two new tests may already pass: they pin the wire value, and Step 5 proves them.
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

`server/src/analyzer/capacity.ts`: add `import { getCachedGeminiModelInfo } from './catalog/gemini-catalog.js';`, replace the Gemini return in `resolveCapacity` with the block below, and append the function after it:
```ts
  const cap = resolveMaxInputTokensPerRequest();
  const listed = getCachedGeminiModelInfo(sel.model);
  return {
    family: 'requestCap',
    contextTokens: listed?.inputTokenLimit ?? cap,
    maxOutputTokens: listed?.outputTokenLimit ?? GEMINI_FALLBACK_MAX_OUTPUT_TOKENS,
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
In the same file, change the header sentence `Endpoints (context family + optional cap) arrive in wave 3.` to `Gemini's context/output limits come from the cached model list (catalog/gemini-catalog.ts); endpoints (context family + optional cap) arrive in wave 3.`

`server/src/analyzer/runner/transport.ts`: in `interface ChatTransport`, after `send(req: TransportRequest): Promise<TransportResult>;`, add:
```ts
  /** Optional async warm-up the runner awaits before reading EngineRequestSettings
      on every stage call — keeps settings resolution synchronous (e.g. the Gemini
      model catalog behind Auto max output tokens). Must never reject. */
  prepare?(): Promise<void>;
```

`server/src/analyzer/runner/stage-runner.ts`: add this private method to `StageRunner`, and replace every `this.opts.settings()` call with `await this.resolveSettings()`. Each enclosing method is already `async`.
```ts
  private async resolveSettings(): Promise<EngineRequestSettings> {
    await this.opts.transport.prepare?.();
    return this.opts.settings();
  }
```

`server/src/analyzer/transports/gemini-transport.ts`:
- **Imports.** Add `import { warmGeminiCatalog, type GeminiModelsClient } from '../catalog/gemini-catalog.js';` and `import { GEMINI_FALLBACK_MAX_OUTPUT_TOKENS } from '../capacity.js';`.
- **Constructor.** If the constructor does not already keep the key, add `private readonly apiKey: string;` and assign `this.apiKey = opts.apiKey;`.
- **`prepare()`.** Add the method:
```ts
  prepare(): Promise<void> {
    return warmGeminiCatalog(this.apiKey, { client: this.client as unknown as GeminiModelsClient });
  }
```
- **`config` literal.** In the `config` object passed to `generateContentStream` (moved from `gemini.ts:728-734`), replace `maxOutputTokens: resolveMaxOutputTokens(),` (or wave 1's `req.maxOutputTokens ?? resolveMaxOutputTokens()`) with:
```ts
          maxOutputTokens: req.maxOutputTokens ?? GEMINI_FALLBACK_MAX_OUTPUT_TOKENS,
```
Thread `req.maxOutputTokens` into the streaming method, which today takes `(contents, systemInstruction, callerSignal, onChunk)`: add a trailing `maxOutputTokens: number | undefined` parameter and pass `req.maxOutputTokens` from `send`, unless wave 1 already passes `req` through.

`server/src/analyzer/transports/ollama-transport.ts`: in the request body's `options` (moved from `ollama.ts:631-674`), make `num_predict` read:
```ts
        num_predict: req.maxOutputTokens ?? resolveNumPredict(),
```

`server/src/analyzer/gemini.ts`: in `GeminiAnalyzer`'s `new StageRunner({ … settings: () => ({ … }) … })`, set `maxOutputTokens: resolveGeminiMaxOutputTokens(model),` (import it from `./capacity.js`, where `model` is the constructor's model). Then:
- run `git grep -n "resolveMaxOutputTokens\|DEFAULT_MAX_OUTPUT_TOKENS" server/src`. If the only hits are their definitions (today `:80-91`, including the `#528` comment block), delete them;
- change the comment at `:62-64` from ``The runtime `resolveMaxOutputTokens` cap is NOT visible to static analysis.`` to ``The runtime max-output cap (`resolveGeminiMaxOutputTokens`, analyzer/capacity.ts) is NOT visible to static analysis.``

`server/src/analyzer/ollama.ts`: in `OllamaAnalyzer`'s `settings` provider, set `maxOutputTokens: resolveNumPredict(),`.

`server/.env.example:293`:
```
#       ANALYZER_MAX_OUTPUT_TOKENS  Gemini maxOutputTokens (default 0 = Auto: the model's own limit, 8192 if unknown)
```
and `:301`:
```
# ANALYZER_MAX_OUTPUT_TOKENS=0
```
The managed block line (`:507`) is regenerated in Task 2.11 by `npm run config:sync`.
- [ ] **Step 4: Run and confirm it passes**
Run:
```
npm --prefix server run test -- src/analyzer/capacity.test.ts src/analyzer/capacity-pinning.test.ts src/analyzer/ollama.test.ts src/analyzer/catalog src/analyzer/runner src/analyzer/transports src/config
npm --prefix server run test:slow -- src/analyzer/gemini.test.ts
npm run typecheck
npm run check:cycles
```
Expected: PASS. `src/config` covers `env-cleanup.test.ts`, whose "realistic .env" test derives candidates from registry defaults (`env-cleanup.test.ts:389-402`), so `ANALYZER_MAX_OUTPUT_TOKENS=8192` simply stops being a candidate.
- [ ] **Step 5: Mutation proof**
  1. In `stage-runner.ts`'s `resolveSettings`, delete `await this.opts.transport.prepare?.();`. Expected red: `… the catalog is warmed BEFORE the request is built` (`listModels` called 0 times). Restore it.
  2. In `capacity.ts`, change `return limit !== undefined ? Math.min(configured, limit) : configured;` to `return configured;`. Expected red: `resolveGeminiMaxOutputTokens > an explicit value above the listed limit is clamped to it`. Restore it.
  3. In `ollama.ts`'s settings provider, set `maxOutputTokens: 123,`. Expected red: `OllamaAnalyzer — the resolved output cap reaches the wire > sends options.num_predict from the runner-resolved maxOutputTokens`. Restore it.
- [ ] **Step 6: Commit**
```bash
git add server/src/config/registry.ts server/src/analyzer/capacity.ts server/src/analyzer/capacity.test.ts server/src/analyzer/runner/transport.ts server/src/analyzer/runner/stage-runner.ts server/src/analyzer/transports/gemini-transport.ts server/src/analyzer/transports/ollama-transport.ts server/src/analyzer/gemini.ts server/src/analyzer/ollama.ts server/src/analyzer/gemini.test.ts server/src/analyzer/ollama.test.ts server/.env.example
git commit -m "feat(server): Gemini max output tokens default to Auto (#3084)"
```

**Tests this task could break:**
- `gemini.test.ts` (slow; every test now warms a catalog that fails once);
- `ollama.test.ts` and `ollama-timeout.test.ts`;
- wave 1's runner, transport and characterisation suites (`src/analyzer/runner`, `src/analyzer/transports`), including any fake `ChatTransport` without `prepare`, which the optional call tolerates;
- `src/config/*` (knob bounds, `env-example.test.ts`, `env-cleanup.test.ts`, and after #3146 `registry-knob-read.guard.test.ts`);
- `capacity-pinning.test.ts`.

### Task 2.8: Gemini thought summaries — `includeThoughts`, reasoning tokens, heartbeat

**Files:**
- Modify: `server/src/analyzer/transports/gemini-transport.ts`. The streaming method moved from `gemini.ts:678-866`: request `config` at today's `:728-734`, usage tracking at `:739-767`, and the text-less chunk skip at `:772`.
- Test: `server/src/analyzer/transports/gemini-transport-thinking.test.ts` (new)

**Interfaces:**
- Consumes:
  - `geminiModelThinks(model)` and `listGeminiModels` (Task 2.6);
  - `GeminiTransport` constructor `{ apiKey, model, client? }` and `send(req: TransportRequest): Promise<TransportResult>` (contract);
  - `ThinkingConfig.includeThoughts` (`genai.d.ts:14398`) and `usageMetadata.thoughtsTokenCount` (`genai.d.ts:5917`).
- Produces:
  - Gemini requests carry `config.thinkingConfig = { includeThoughts: true }` when the model thinks. This key is transport-owned (decision 9); wave 5 adds `thinkingLevel` / `thinkingBudget` beside it.
  - `TransportResult.usage.reasoningTokens` = the last `thoughtsTokenCount` seen.
  - A chunk that carries thought parts but no answer text fires `call.onChunk` with `receivedBytes` / `receivedText` unchanged, so the route heartbeat (`routes/analysis.ts:1184` `SILENCE_THRESHOLD_MS` warning at `:4329-4335`) sees activity during thinking.
  - Wave 1 already keeps thought text out of `text` and sets `reasoningSeen` (contract); this task pins both.

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

  it('does not send thinkingConfig to a model that does not think', async () => {
    const gen = vi.fn().mockResolvedValue(streamOf([chunk([{ text: ANSWER }], { finishReason: 'STOP' })]));
    await new GeminiTransport({ apiKey: 'test-key', model: 'gemma-4-31b-it', client: clientWith(gen) }).send(request());
    expect(gen.mock.calls[0][0].config.thinkingConfig).toBeUndefined();
  });

  it('follows the catalog thinking flag over the id rule', async () => {
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
    expect(gen.mock.calls[0][0].config.thinkingConfig).toEqual({ includeThoughts: true });
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

  it('a thought-only chunk feeds the heartbeat without adding answer bytes', async () => {
    const onChunk = vi.fn();
    const gen = vi.fn().mockResolvedValue(
      streamOf([
        chunk([{ thought: true, text: 'thinking' }]),
        chunk([{ text: ANSWER }], { finishReason: 'STOP' }),
      ]),
    );
    await new GeminiTransport({ apiKey: 'test-key', model: 'gemini-3.6-flash', client: clientWith(gen) }).send(
      request({ call: { onChunk } }),
    );
    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(onChunk.mock.calls[0][0]).toMatchObject({ receivedBytes: 0, receivedText: '' });
    expect(onChunk.mock.calls[1][0]).toMatchObject({ receivedBytes: ANSWER.length, receivedText: ANSWER });
  });
});
```
Task 2.9A or Task 2.9B appends a `describe` to this same file and reuses `chunk`, `streamOf`, `clientWith`, `request` and `ANSWER` from it.
- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/analyzer/transports/gemini-transport-thinking.test.ts`
Expected FAIL:
- `asks a thinking model for thought summaries` (received `undefined`);
- `follows the catalog thinking flag over the id rule`;
- `… reports thoughtsTokenCount as reasoningTokens` (received `undefined`);
- `a thought-only chunk feeds the heartbeat…` (called 1 time).

`keeps thought text out of the answer` may partly pass on wave 1's code.
- [ ] **Step 3: Implement**

In `gemini-transport.ts`, add `import { geminiModelThinks } from '../catalog/gemini-catalog.js';`, then make three edits. The names are today's `gemini.ts` locals, which wave 1 moved verbatim. If wave 1 renamed one, apply the same edit to its renamed counterpart.

1. In the request `config` object, after `temperature`, add:
```ts
          ...(geminiModelThinks(this.model) ? { thinkingConfig: { includeThoughts: true } } : {}),
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
   - In the `TransportResult` the method returns, set `usage.reasoningTokens: thoughtsTokenCount`, keeping wave 1's other `usage` fields.
3. Replace the text-less chunk skip (today `if (!text) continue;` at `:772`) with:
```ts
        if (!text) {
          /* #3084 wave 2b — a thought-only chunk (includeThoughts) is proof the
             model is alive: feed the route heartbeat with the answer buffer
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
Expected: PASS.
- [ ] **Step 5: Mutation proof**
  1. Delete the `...(geminiModelThinks(this.model) ? … : {}),` line. Expected red: `GeminiTransport — thought summaries (#3084 wave 2b) > asks a thinking model for thought summaries`. Restore it.
  2. Delete the `onChunk?.({…})` call inside `if (chunkHadThought)`. Expected red: `… > a thought-only chunk feeds the heartbeat without adding answer bytes`. Restore it.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/transports/gemini-transport.ts server/src/analyzer/transports/gemini-transport-thinking.test.ts
git commit -m "feat(server): request Gemini thought summaries from thinking models (#3084)"
```

**Tests this task could break:**
- `gemini.test.ts` (slow): the `onChunk` count tests at `:83-117`. Their mock chunks carry no `candidates[].content.parts`, so `chunkHadThought` is false and the counts are unchanged;
- wave 1's `src/analyzer/transports` and `src/analyzer/runner` suites.

---

> **Execute exactly ONE of Task 2.9A / Task 2.9B**, chosen by the `Branch:` line in run sheet §1 (`docs/testing/3084-openai-analyzer-onbox-acceptance.md`). Record the executed branch in the PR body. Do not start either before that line is filled in.

### Task 2.9A (Branch A only): pin the pre-first-chunk watchdog kept alive by thought parts

**Files:**
- Modify: `server/src/analyzer/transports/gemini-transport.ts`: the comment on the pre-stream `armIdleTimer()` call (today `gemini.ts:724`).
- Test (modify): `server/src/analyzer/transports/gemini-transport-thinking.test.ts`

**Interfaces:**
- Consumes:
  - `resolveStreamIdleTimeoutMs()` (env `GEMINI_STREAM_IDLE_MS`, read per request, `gemini.ts:73-78`);
  - `BACKOFFS_MS` (env `GEMINI_RETRY_BACKOFFS_MS`, read at module load, `gemini.ts:102-111`);
  - wave 1's `withTransportRetry` idle retry (`maxAttempts` 3);
  - `GeminiStreamIdleError` (`gemini.ts:118-127`).
- Produces: no new names. It pins that a thinking stream whose thought parts arrive more often than the idle window completes on one request, and that a genuinely silent pre-first-chunk stream still trips the watchdog.

- [ ] **Step 1: Write the failing test**

In `gemini-transport-thinking.test.ts`, directly after the `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';` line, add the snippet below. Vitest hoists `vi.hoisted` above every import.
```ts
vi.hoisted(() => {
  /* BACKOFFS_MS is read at module load — zero it before gemini.ts evaluates so
     a 3-attempt idle exhaustion finishes in ~1 s, not ~9 s. */
  process.env.GEMINI_RETRY_BACKOFFS_MS = '0,0';
});
```
Append this `describe`:
```ts
describe('Branch A — the pre-first-chunk idle watchdog stays, thought parts keep it alive (#3084 wave 2b, run sheet §1)', () => {
  it('a long think whose thought parts arrive faster than the idle window completes on ONE request', async () => {
    process.env.GEMINI_STREAM_IDLE_MS = '300';
    const thoughts = Array.from({ length: 6 }, () => chunk([{ thought: true, text: '…' }]));
    const gen = vi.fn().mockResolvedValue(
      streamOf([...thoughts, chunk([{ text: ANSWER }], { finishReason: 'STOP', thoughtsTokenCount: 900 })], 150),
    );
    const result = await new GeminiTransport({ apiKey: 'test-key', model: 'gemini-3.6-flash', client: clientWith(gen) }).send(request());
    expect(result.text).toBe(ANSWER);
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it('a stream silent before its first chunk still trips the idle watchdog (and is retried like today)', async () => {
    process.env.GEMINI_STREAM_IDLE_MS = '300';
    const gen = vi.fn().mockImplementation(async () => streamOf([chunk([{ text: ANSWER }], { finishReason: 'STOP' })], 0, 900));
    await expect(
      new GeminiTransport({ apiKey: 'test-key', model: 'gemini-3.6-flash', client: clientWith(gen) }).send(request()),
    ).rejects.toMatchObject({ name: 'GeminiStreamIdleError' });
    expect(gen).toHaveBeenCalledTimes(3);
  });
});
```
- [ ] **Step 2: Run it and confirm it fails**
Run: `npm --prefix server run test -- src/analyzer/transports/gemini-transport-thinking.test.ts`  Expected: PASS. Both tests pin behaviour that wave 1 and Task 2.8 already have. The red run for this task is Step 5's mutation, which proves the tests can fail.
- [ ] **Step 3: Implement**

In `gemini-transport.ts`, directly above the pre-stream `armIdleTimer();` (today `gemini.ts:724`), add:
```ts
      /* #3084 wave 2 Branch A (docs/testing/3084-openai-analyzer-onbox-acceptance.md §1):
         armed BEFORE the first chunk on purpose — Gemini streams thought parts
         during thinking (includeThoughts), and each one re-arms this watchdog
         in the loop below, so a long think is not mistaken for a wedged stream. */
```
- [ ] **Step 4: Run and confirm it passes**
Run: `npm --prefix server run test -- src/analyzer/transports/gemini-transport-thinking.test.ts`  Expected: PASS (7 tests).
- [ ] **Step 5: Mutation proof**
  1. In the stream loop, delete the per-chunk `armIdleTimer();` (today `gemini.ts:758`). Expected red: `Branch A — … > a long think whose thought parts arrive faster than the idle window completes on ONE request` (`GeminiStreamIdleError`). Restore it.
  2. Delete the pre-stream `armIdleTimer();`. Expected red: `… > a stream silent before its first chunk still trips the idle watchdog`. Restore it.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/transports/gemini-transport.ts server/src/analyzer/transports/gemini-transport-thinking.test.ts
git commit -m "test(server): pin Gemini idle watchdog through streamed thought parts (#3084)"
```

**Tests this task could break:** `gemini.test.ts`'s idle-retry tests (slow; unchanged code) and wave 1's transport suites.

### Task 2.9B (Branch B only): arm the watchdog after the first chunk; bound the silent wait with a request ceiling

**Files:**
- Modify: `server/src/analyzer/errors.ts` (append `AnalyzerTimeoutError`, contract shape)
- Modify: `server/src/config/registry.ts`: add the knob after `analyzer.gemini.maxInputTokensPerRequest` (today `:70-79`).
- Modify: `server/src/analyzer/transports/gemini-transport.ts`:
  - constructor option `requestCeilingMs?: number`;
  - in the streaming method (today `gemini.ts:684-735`, `:820-831`), remove the pre-stream `armIdleTimer()`, add the ceiling signal, and add the ceiling classification.
- Modify: `server/src/routes/failure-taxonomy.ts:29-52` (union), `:98-140` (signature row), `:492-534` (classify branch)
- Modify: `server/src/routes/failure-remediations.ts:94-101` (add an entry after `analyzer-truncated`)
- Modify: `openapi.yaml:7049` (enum), and regenerate `src/lib/api-types.ts`.
- Modify: `src/data/help-failures.ts:28-55` (`CATEGORIES`), `:57-81` (`TITLES`)
- Test (modify):
  - `server/src/analyzer/transports/gemini-transport-thinking.test.ts`;
  - `server/src/routes/failure-taxonomy.test.ts:399-428` and a new test;
  - `src/data/help-failures.test.ts:13` (23 → 24);
  - `src/data/help-categories.test.ts:24` (49 → 50).

**Interfaces:**
- Consumes: `TransportKind` (`errors.ts`, wave 1), `configValue`, `withCopy` (`failure-taxonomy.ts:481-483`).
- Produces:
  - `export class AnalyzerTimeoutError extends Error { readonly code = 'ANALYZER_TIMEOUT'; constructor(readonly transport: TransportKind, readonly model: string, readonly elapsedMs: number, readonly reason: 'ceiling' | 'connect-timeout') }`. This is the contract class, pulled forward from wave 3; wave 3 reuses it and must not re-add it.
  - Knob `analyzer.gemini.requestCeilingMs` (env `ANALYZER_GEMINI_REQUEST_CEILING_MS`, default `1_800_000`).
  - FailureCode `analyzer-timeout`, also pulled forward from wave 3.

**Behaviour:**
- **Before the first chunk:**
  - the idle watchdog is NOT armed;
  - the request is bounded by `AbortSignal.timeout(requestCeilingMs)`, created inside the per-attempt streaming call. That call runs after `withTransportRetry` acquires the limiter, so queue time is not charged (spec §1).
- **From the first chunk on,** the 45 s watchdog is re-armed on every chunk, as today.
- **Classification order in the `catch`:**
  1. idle fired → `GeminiStreamIdleError` (retried);
  2. caller aborted → `AnalysisAbortedError`;
  3. ceiling aborted → `AnalyzerTimeoutError(…, 'ceiling')`. It has no `status`, so wave 1's classifier treats it as `no-retry`, and it is never a fallback.
- **Known consequence.** Gemini's `maxTotalMs` stays 90 000 (contract). A mid-stream idle error after a long request is therefore not retried: the loop's elapsed check breaks first and the idle error is thrown.

- [ ] **Step 1: Write the failing test**

In `gemini-transport-thinking.test.ts`, directly after the `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';` line, add the snippet below. Vitest hoists `vi.hoisted` above every import.
```ts
vi.hoisted(() => {
  /* BACKOFFS_MS is read at module load — zero it before gemini.ts evaluates. */
  process.env.GEMINI_RETRY_BACKOFFS_MS = '0,0';
});
```
Add `import { allKnobs } from '../../config/registry.js';` to its imports. Append:
```ts
describe('Branch B — idle watchdog after the first chunk, request ceiling before it (#3084 wave 2b, run sheet §1)', () => {
  it('a silence before the first chunk longer than the idle window completes (no idle retry)', async () => {
    process.env.GEMINI_STREAM_IDLE_MS = '200';
    const gen = vi.fn().mockImplementation(async () =>
      streamOf([chunk([{ text: ANSWER }], { finishReason: 'STOP' })], 0, 600),
    );
    const result = await new GeminiTransport({ apiKey: 'test-key', model: 'gemini-3.6-flash', client: clientWith(gen), requestCeilingMs: 5_000 }).send(request());
    expect(result.text).toBe(ANSWER);
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it('a silence AFTER the first chunk still trips the idle watchdog and is retried like today', async () => {
    process.env.GEMINI_STREAM_IDLE_MS = '200';
    const gen = vi.fn().mockImplementation(async () =>
      streamOf([chunk([{ thought: true, text: '…' }]), chunk([{ text: ANSWER }], { finishReason: 'STOP' })], 700),
    );
    await expect(
      new GeminiTransport({ apiKey: 'test-key', model: 'gemini-3.6-flash', client: clientWith(gen), requestCeilingMs: 5_000 }).send(request()),
    ).rejects.toMatchObject({ name: 'GeminiStreamIdleError' });
    expect(gen).toHaveBeenCalledTimes(3);
  });

  it('a pre-first-chunk silence past the ceiling fails as AnalyzerTimeoutError, once, never retried', async () => {
    process.env.GEMINI_STREAM_IDLE_MS = '200';
    const gen = vi.fn().mockImplementation(async () =>
      streamOf([chunk([{ text: ANSWER }], { finishReason: 'STOP' })], 0, 2_000),
    );
    await expect(
      new GeminiTransport({ apiKey: 'test-key', model: 'gemini-3.6-flash', client: clientWith(gen), requestCeilingMs: 300 }).send(request()),
    ).rejects.toMatchObject({ name: 'AnalyzerTimeoutError', reason: 'ceiling', transport: 'gemini' });
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it('a caller abort during the silent wait is an abort, not a timeout', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const gen = vi.fn().mockImplementation(async () =>
      streamOf([chunk([{ text: ANSWER }], { finishReason: 'STOP' })], 0, 2_000),
    );
    await expect(
      new GeminiTransport({ apiKey: 'test-key', model: 'gemini-3.6-flash', client: clientWith(gen), requestCeilingMs: 5_000 }).send(
        request({ signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ name: 'AnalysisAbortedError' });
  });

  it('the ceiling knob ships with its bounds and a 30-minute default', () => {
    expect(allKnobs().find((k) => k.key === 'analyzer.gemini.requestCeilingMs')).toMatchObject({
      env: 'ANALYZER_GEMINI_REQUEST_CEILING_MS',
      type: 'integer',
      min: 60_000,
      max: 14_400_000,
      default: 1_800_000,
    });
  });
});
```

In `server/src/routes/failure-taxonomy.test.ts`:
- **Sorted list.** Add `'analyzer-timeout',` to the list at `:402-426`, after `'analyzer-rate-limit',`.
- **Import.** Add `AnalyzerTimeoutError` to the `../analyzer/errors.js` import.
- **New tests.** Append:
```ts
describe('AnalyzerTimeoutError (#3084 wave 2b Branch B)', () => {
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
npm --prefix server run test -- src/analyzer/transports/gemini-transport-thinking.test.ts src/routes/failure-taxonomy.test.ts
npx vitest run src/data/help-failures.test.ts src/data/help-categories.test.ts
```
Expected FAIL:
- `Branch B — … > a silence before the first chunk longer than the idle window completes` (`GeminiStreamIdleError`);
- `… past the ceiling fails as AnalyzerTimeoutError` (no such error);
- `… ceiling knob ships…` (`undefined`);
- `failure-remediations copy module … has exactly one entry per FailureCode`;
- `AnalyzerTimeoutError …` (`AnalyzerTimeoutError is not a constructor`);
- the two help counts (received 23 / 49).
- [ ] **Step 3: Implement**

`server/src/analyzer/errors.ts` (append):
```ts
/* #3084 — a request ran past an absolute ceiling (spec §1 decision 1c). Wave 2
   (Branch B) throws it from the Gemini transport when a request stays silent
   before its first chunk past analyzer.gemini.requestCeilingMs; wave 3 reuses
   it for OpenAI-compatible endpoints ('connect-timeout' too). Never retried,
   never a fallback: the upstream was reachable and did not finish. */
export class AnalyzerTimeoutError extends Error {
  readonly code = 'ANALYZER_TIMEOUT';
  constructor(
    public readonly transport: TransportKind,
    public readonly model: string,
    public readonly elapsedMs: number,
    public readonly reason: 'ceiling' | 'connect-timeout',
  ) {
    super(
      `${transport} ${model} request exceeded its ${reason === 'ceiling' ? 'time ceiling' : 'connect timeout'} after ${elapsedMs} ms.`,
    );
    this.name = 'AnalyzerTimeoutError';
  }
}
```

`server/src/config/registry.ts`, inserted after the `analyzer.gemini.maxInputTokensPerRequest` knob (today ending `:79`):
```ts
  {
    key: 'analyzer.gemini.requestCeilingMs',
    env: 'ANALYZER_GEMINI_REQUEST_CEILING_MS',
    group: 'analyzer-sampling',
    label: 'Gemini request ceiling (ms)',
    help: "Absolute time limit for one Gemini analysis request, counted after rate-limit waits. Gemini's 45 s idle watchdog only starts once the first chunk arrives, because a thinking model can stay silent until its answer begins; this ceiling bounds that silent wait. A request that reaches it fails as analyzer-timeout and is not retried. Default 1800000 (30 min).",
    type: 'integer', min: 60_000, max: 14_400_000,
    default: 1_800_000,
    apply: 'live', risk: 'medium',
  },
```

`server/src/analyzer/transports/gemini-transport.ts`:
- **Imports.** Add `import { AnalyzerTimeoutError } from '../errors.js';` and `import { configValue } from '../../config/resolver.js';` (skip whichever it already imports).
- **Constructor option.** Add `requestCeilingMs?: number` to the constructor options type, and store it as `private readonly requestCeilingMs: number | undefined;` (`this.requestCeilingMs = opts.requestCeilingMs;`). It is a test seam: the knob's minimum is 60 000 ms.
- **Ceiling signal.** In the streaming method, replace today's `:684-689`:
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
    /* #3084 wave 2 Branch B (docs/testing/3084-openai-analyzer-onbox-acceptance.md §1):
       Gemini does not stream thought parts while it thinks, so the idle
       watchdog cannot run before the first chunk. The silent wait is bounded by
       this absolute ceiling instead — created here, inside the per-attempt call
       that runs AFTER the limiter was acquired, so queue time is not charged. */
    const requestCeilingMs = this.requestCeilingMs ?? configValue<number>('analyzer.gemini.requestCeilingMs');
    const ceiling = AbortSignal.timeout(requestCeilingMs);
    const requestStartedAt = Date.now();

    const signals: AbortSignal[] = [watchdog.signal, ceiling];
    if (callerSignal) signals.push(callerSignal);
    const combined = AbortSignal.any(signals);
```
- **Watchdog arming.** Delete the pre-stream `armIdleTimer();` (today `:724`, the first statement inside `try`). Keep the per-chunk `armIdleTimer();` (today `:758`); it arms the watchdog on the first chunk.
- **Ceiling classification.** In the `catch`, directly after the `if (callerSignal?.aborted) { … }` block (today `:827-831`), add:
```ts
      if (ceiling.aborted) {
        throw new AnalyzerTimeoutError('gemini', this.model, Date.now() - requestStartedAt, 'ceiling');
      }
```

`server/src/routes/failure-taxonomy.ts`:
- **Union.** Add `| 'analyzer-timeout'` after `| 'analyzer-truncated'` (`:35`).
- **Import.** Change the errors import (`:26`) to `import { AnalyzerTimeoutError, AnalyzerTruncatedError } from '../analyzer/errors.js';`.
- **Signature row.** Insert after the `analyzer-truncated` signature row (`:103-109`). It is `fatal: true`. `fatal` is the table's legacy stop-the-run-vs-skip-and-advance flag. A ceiling timeout is never retried and never falls back, so it matches `analyzer-unreachable` (`fatal: true`, a request that could not complete). It does not match `analyzer-truncated` (`fatal: false`, which splitting the chunk recovers). Wave 3b's "timeout: skip if found" branch keeps this row unchanged.
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
    const setting =
      err.transport === 'gemini'
        ? "'Gemini request ceiling' (ANALYZER_GEMINI_REQUEST_CEILING_MS)"
        : "this endpoint's request ceiling";
    return withCopy(
      'analyzer-timeout',
      `${modelLabel} did not finish within ${Math.round(err.elapsedMs / 1000)} s (the request ceiling). Raise ${setting}, lower the model's reasoning level, or pick a faster model, then retry.`,
      `transport=${err.transport} model=${err.model} reason=${err.reason} elapsedMs=${err.elapsedMs}`,
    );
  }
```

`server/src/routes/failure-remediations.ts`, inserted after the `'analyzer-truncated'` entry (`:94-101`):
```ts
  'analyzer-timeout': {
    userMessage:
      'The analyzer request ran past its time ceiling without finishing, so it was stopped instead of ' +
      'being left to hang.',
    remediation:
      "Retry the chapter. If it recurs, raise 'Gemini request ceiling' (ANALYZER_GEMINI_REQUEST_CEILING_MS) " +
      "in Advanced Settings, lower the model's reasoning level, or switch to a faster analyzer model.",
  },
```

`openapi.yaml`: insert `        - analyzer-timeout` after `        - analyzer-content-blocked` (`:7049`), then run `npm run openapi:types`.

`src/data/help-failures.ts`: in `CATEGORIES`, add `'analyzer-timeout': 'analysis',` after `'analyzer-truncated': 'analysis',` (`:34`). In `TITLES`, add `'analyzer-timeout': 'Analyzer request ran past its time limit',` after `'analyzer-truncated': …` (`:63`).
- [ ] **Step 4: Run and confirm it passes**
Run:
```
npm run openapi:types
npm --prefix server run test -- src/analyzer/transports src/routes/failure-taxonomy.test.ts src/config
npm --prefix server run test:slow -- src/analyzer/gemini.test.ts
npx vitest run src/data/help-failures.test.ts src/data/help-categories.test.ts
npm run typecheck
```
Expected: PASS.

`gemini.test.ts` has idle-retry tests (search `GEMINI_STREAM_IDLE_MS`) whose streams stall before their first chunk. Each one is either:
- rewritten so the stall comes after a first chunk, keeping its retry assertion, **or**
- moved to a ceiling assertion using a constructor `requestCeilingMs` seam through a `GeminiTransport`.

List every rewritten test name in the PR body. None may be deleted.
- [ ] **Step 5: Mutation proof**
  1. Restore the pre-stream `armIdleTimer();`. Expected red: `Branch B — … > a silence before the first chunk longer than the idle window completes (no idle retry)`. Remove it again.
  2. Delete the `if (ceiling.aborted) { … }` block. Expected red: `… > a pre-first-chunk silence past the ceiling fails as AnalyzerTimeoutError, once, never retried`. Restore it.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/errors.ts server/src/config/registry.ts server/src/analyzer/transports/gemini-transport.ts server/src/analyzer/transports/gemini-transport-thinking.test.ts server/src/analyzer/gemini.test.ts server/src/routes/failure-taxonomy.ts server/src/routes/failure-remediations.ts server/src/routes/failure-taxonomy.test.ts openapi.yaml src/lib/api-types.ts src/data/help-failures.ts src/data/help-failures.test.ts src/data/help-categories.test.ts
git commit -m "feat(server,openapi,frontend): bound Gemini's silent pre-first-chunk wait with a request ceiling (#3084)"
```

**Tests this task could break:**
- `gemini.test.ts` idle tests (slow, handled in Step 4);
- `failure-taxonomy.test.ts`, `help-failures.test.ts`, `help-categories.test.ts`;
- `src/config/*` (knob guards, `env-example.test.ts`; after #3146 `registry-knob-read.guard.test.ts` requires the transport's read, which exists);
- `src/views/help.tsx` consumers (`HELP_FAILURE_ENTRIES`).

### Task 2.10: Reasoning overflow fails instead of splitting

**Files:**
- Modify: `server/src/analyzer/errors.ts` (append `AnalyzerReasoningOverflowError`)
- Modify: `server/src/analyzer/runner/finish.ts` (`hasReasoningEvidence`; `mapFinish` rewritten so the `'length'` rule runs before Ollama's empty-response check)
- Modify: `server/src/analyzer/transports/ollama-transport.ts` (wave 1 Task 1.8's moved `chat()` body: `reasoningSeen` from `message.thinking`, and each thinking chunk calls `onChunk` with the answer byte count unchanged (P4); the empty-buffer early return logs its truncation)
- Modify: `server/src/routes/failure-taxonomy.ts:29-52` (union), `:98-140` (signature row), `:492-534` (classify branch)
- Modify: `server/src/routes/failure-remediations.ts:94-101` (add after `analyzer-truncated`)
- Modify: `openapi.yaml:7049` (enum), and regenerate `src/lib/api-types.ts`.
- Modify: `src/data/help-failures.ts:28-55`, `:57-81`
- Test:
  - Create: `server/src/analyzer/runner/finish-reasoning-overflow.test.ts`, `server/src/analyzer/transports/ollama-transport-overflow.test.ts`
  - Modify:
    - `server/src/analyzer/runner/finish.test.ts` (wave 1 Task 1.7's `ollama EMPTY length …` case — a deliberate behaviour change, below);
    - `server/src/analyzer/stage1-chunk.test.ts` (append to `describe('runStage1ChapterChunked')`);
    - `server/src/analyzer/stage2-chunk.test.ts` (append after `:243`);
    - `server/src/analyzer/gemini.test.ts` (the `GeminiAnalyzer — output truncation (#528)` describe at `:746`);
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
  - FailureCode `analyzer-reasoning-overflow`.

**The rule (spec §7, Truncation):**

| `length` finish, and… | Result |
|---|---|
| answer text present, with or without reasoning evidence | `AnalyzerTruncatedError` (the chunk splits, as today) |
| no answer text, no reasoning evidence | `AnalyzerTruncatedError` — keeps the Gemma empty-`MAX_TOKENS` recovery (`gemini.ts:784-804`) |
| no answer text, with reasoning evidence | `AnalyzerReasoningOverflowError` — never splits |

Evidence is `usage.reasoningTokens > 0`, `reasoningSeen`, or an unterminated leading `<think>` block. "No answer text" means `stripThink(r.text).text.trim() === ''`.

The overflow error is not an `AnalyzerTruncatedError`, so both chunkers rethrow it on the first call (`stage1-chunk.ts:175`, `:198`; `stage2-chunk.ts:428`, `:553`), as does script review's force-split (`review-run.ts:99`).

**Ollama ordering — a deliberate change.** On 2b63b451 Ollama checks for an empty buffer before `done_reason` (`ollama.ts:829` throws `Ollama <model> returned an empty response.`; the `length` check is at `:838`), so an empty `done_reason: 'length'` stream fails as a generic empty response and never splits. Wave 1 preserved that order inside `mapFinish` (Task 1.7), while `OllamaTransport` already reports `finish: 'length'` for an empty `length` stream (Task 1.8). This task moves the `'length'` rule ahead of the empty check for every transport, so the table above applies to Ollama uniformly:
- empty `length`, no evidence → `AnalyzerTruncatedError` (0 bytes; the chunk splits);
- empty `length` after non-empty `message.thinking` chunks → `AnalyzerReasoningOverflowError` (`OllamaTransport` now sets `reasoningSeen` from `message.thinking`);
- empty `stop` → still today's `Ollama <model> returned an empty response.`

Help counts depend on the branch executed:
- **Branch A.** `help-failures.test.ts` 23 → 24; `help-categories.test.ts` 49 → 50.
- **Branch B.** Task 2.9B already moved them to 24 / 50, so this task takes them to 25 / 51.

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
/* #3084 wave 2b — Ollama's empty `length` stream (spec §7). On 2b63b451 an
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
        { text: undefined, candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: { thoughtsTokenCount: 8100 } },
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
```
In that file's top-level `afterAll`, add:
```ts
  await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_overflow-stage1.md'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_overflow_gemma-stage1.md'), { force: true });
```

In `server/src/routes/failure-taxonomy.test.ts`:
- **Sorted list.** Add `'analyzer-reasoning-overflow',` to the list at `:402-426`.
- **Import.** Add `AnalyzerReasoningOverflowError` to the `../analyzer/errors.js` import.
- **New tests.** Append:
```ts
describe('AnalyzerReasoningOverflowError (#3084 wave 2b)', () => {
  it('→ analyzer-reasoning-overflow, naming the Gemini max-output setting and the reasoning level', () => {
    const r = classifyAnalysisFailure(
      new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100),
      'Gemini (gemini-3.6-flash)',
    );
    expect(r.code).toBe('analyzer-reasoning-overflow');
    expect(r.userMessage).toContain('Gemini (gemini-3.6-flash)');
    expect(r.userMessage).toContain('Gemini max output tokens');
    expect(r.userMessage).toContain('reasoning level');
    expect(r.remediation).toContain('reasoning');
    expect(r.detail).toContain('reasoningTokens=8100');
  });

  it('names Ollama num_predict for an Ollama overflow', () => {
    const r = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('ollama', 'qwen3.5:4b', undefined), 'Ollama (qwen3.5:4b)');
    expect(r.userMessage).toContain('Ollama num_predict');
  });

  it('is matched by name in the signature scan', () => {
    expect(classifyAnalysisError(new AnalyzerReasoningOverflowError('ollama', 'qwen3.5:4b', undefined)).code).toBe(
      'analyzer-reasoning-overflow',
    );
  });
});
```
- **Help counts.** In `src/data/help-failures.test.ts:13` and `src/data/help-categories.test.ts:24`, add 1 to each current expected count (Branch A: 24 / 50; Branch B: 25 / 51).
- [ ] **Step 2: Run it and confirm it fails**
Run:
```
npm --prefix server run test -- src/analyzer/runner/finish-reasoning-overflow.test.ts src/analyzer/runner/finish.test.ts src/analyzer/transports/ollama-transport-overflow.test.ts src/analyzer/stage1-chunk.test.ts src/analyzer/stage2-chunk.test.ts src/routes/failure-taxonomy.test.ts
npm --prefix server run test:slow -- src/analyzer/gemini.test.ts
npx vitest run src/data/help-failures.test.ts src/data/help-categories.test.ts
```
Expected FAIL:
- `finish.test.ts > … ollama EMPTY length with no reasoning evidence is truncation with 0 bytes…` (received the plain `Error` "Ollama qwen3.5:9b returned an empty response.");
- `ollama-transport-overflow.test.ts`: the file fails to import `AnalyzerReasoningOverflowError`; once that export exists (Step 3's `errors.ts`), `empty content, no message.thinking …` still fails on the empty-response `Error` and `empty content after message.thinking chunks …` fails on `reasoningSeen` (received `false`), until the `finish.ts` and `ollama-transport.ts` edits land;
- every file that imports `AnalyzerReasoningOverflowError`: `does not provide an export named 'AnalyzerReasoningOverflowError'`, or `hasReasoningEvidence is not a function`;
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
     vs :838 on 2b63b451), which made an empty `length` stream the generic
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

`server/src/analyzer/transports/ollama-transport.ts` — edits to wave 1 Task 1.8's moved `chat()` body. The source anchors are the moved lines' positions in `ollama.ts` on 2b63b451; locate each by its text.
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
                 (analysis.ts:1184, :4329-4335) with the answer byte count
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
- **Signature row.** Insert after the `analyzer-truncated` row:
```ts
  {
    code: 'analyzer-reasoning-overflow',
    fatal: false,
    source: 'analysis',
    matchName: 'AnalyzerReasoningOverflowError',
    match: () => false,
  },
```
- **Classify branch.** Insert after the `AnalyzerTruncatedError` branch of `classifyAnalysisFailure`:
```ts
  if (err instanceof AnalyzerReasoningOverflowError) {
    const outputSetting =
      err.transport === 'ollama'
        ? "'Ollama num_predict' (ANALYZER_NUM_PREDICT; -1 = until the context fills)"
        : err.transport === 'gemini'
          ? "'Gemini max output tokens' (ANALYZER_MAX_OUTPUT_TOKENS; 0 = Auto, the model's own limit)"
          : "this endpoint's max output tokens";
    return withCopy(
      'analyzer-reasoning-overflow',
      `${modelLabel} spent its whole output budget reasoning and returned no answer. Raise ${outputSetting}, or lower the model's reasoning level, then retry.`,
      `transport=${err.transport} model=${err.model}${err.reasoningTokens ? ` reasoningTokens=${err.reasoningTokens}` : ''}`,
    );
  }
```

`server/src/routes/failure-remediations.ts`, inserted after `'analyzer-truncated'`:
```ts
  'analyzer-reasoning-overflow': {
    userMessage:
      'The analyzer model spent its whole output budget reasoning and returned no answer — splitting ' +
      'the chapter would not help, because splitting never shrinks reasoning.',
    remediation:
      "Raise the engine's max output setting — Gemini: 'Gemini max output tokens' in Advanced Settings " +
      "(0 = Auto, the model's own limit); Ollama: 'Ollama num_predict' (-1 = until the context fills). " +
      "Or lower the model's reasoning level where the engine offers one, or pick a model that does not " +
      'think. Then retry the chapter.',
  },
```

`openapi.yaml`: in `FailureCode.enum`, insert `        - analyzer-reasoning-overflow` after `        - analyzer-content-blocked` (after `        - analyzer-timeout` if Branch B added it). Then run `npm run openapi:types`.

`src/data/help-failures.ts`: in `CATEGORIES`, add `'analyzer-reasoning-overflow': 'analysis',` after `'analyzer-truncated': 'analysis',`. In `TITLES`, add `'analyzer-reasoning-overflow': 'Analyzer used its output limit on reasoning',` after the `'analyzer-truncated'` title.
- [ ] **Step 4: Run and confirm it passes**
Run:
```
npm run openapi:types
npm --prefix server run test -- src/analyzer/runner src/analyzer/transports src/analyzer/ollama.test.ts src/analyzer/ollama-timeout.test.ts src/analyzer/stage1-chunk.test.ts src/analyzer/stage2-chunk.test.ts src/analyzer/attribution-eval src/routes/failure-taxonomy.test.ts src/analyzer/capacity-pinning.test.ts
npm --prefix server run test:slow -- src/analyzer/gemini.test.ts
npx vitest run src/data/help-failures.test.ts src/data/help-categories.test.ts
npm run typecheck
```
Expected: PASS.
- [ ] **Step 5: Mutation proof**
  1. In `finish.ts`, change `(hasReasoningEvidence(r) || answer.unterminated)` to `answer.unterminated`. Expected red: `mapFinish — reasoning overflow vs truncation (#3084 wave 2b) > length + empty answer + reasoning tokens → AnalyzerReasoningOverflowError carrying the count`, and `GeminiAnalyzer — output truncation (#528) > an empty MAX_TOKENS response WITH thoughtsTokenCount fails as reasoning overflow …`. Restore it.
  2. Change the same condition to `true`. Expected red: `… length + empty answer + NO evidence (Gemma empty MAX_TOKENS) → AnalyzerTruncatedError, so the chunk still splits`. Restore it.
  3. Delete the `AnalyzerReasoningOverflowError` branch in `classifyAnalysisFailure`. Expected red: `AnalyzerReasoningOverflowError (#3084 wave 2b) > → analyzer-reasoning-overflow, naming the Gemini max-output setting…` (the static signature copy lacks the setting name). Restore it.
  4. In `finish.ts`, move `if (ctx.kind === 'ollama' && !r.text) throw …;` above the `if (r.finish === 'length') {` block. Expected red:
     - `Ollama empty \`length\` stream (#3084 wave 2b) > empty content, no message.thinking → finish length, and mapFinish splits it (AnalyzerTruncatedError)`;
     - `… > empty content after message.thinking chunks → reasoningSeen, and mapFinish fails it as reasoning overflow`;
     - `mapFinish — wave 1 … > ollama EMPTY length with no reasoning evidence is truncation with 0 bytes…`.

     Restore it.
  5. In `ollama-transport.ts`, delete `reasoningSeen = true;` inside the `message.thinking` check. Expected red: `… > empty content after message.thinking chunks → reasoningSeen, and mapFinish fails it as reasoning overflow` (received `reasoningSeen: false`). Restore it.
  6. In the empty-buffer early return, change `finish: doneReason === 'length' ? 'length' : 'stop'` to `finish: 'stop'`. Expected red: both `empty content …` `length` cases in `ollama-transport-overflow.test.ts`. The `stop` case stays green. Restore it.
  7. In `ollama-transport.ts`, delete the `onChunk?.({…})` call inside the `message.thinking` check (keep `reasoningSeen = true;`). Expected red: `… > empty content after message.thinking chunks → reasoningSeen, and mapFinish fails it as reasoning overflow` (`expected "spy" to be called 2 times, but got 0 times`). Restore it.
- [ ] **Step 6: Commit**
```bash
git add server/src/analyzer/errors.ts server/src/analyzer/runner/finish.ts server/src/analyzer/runner/finish-reasoning-overflow.test.ts server/src/analyzer/runner/finish.test.ts server/src/analyzer/transports/ollama-transport.ts server/src/analyzer/transports/ollama-transport-overflow.test.ts server/src/analyzer/stage1-chunk.test.ts server/src/analyzer/stage2-chunk.test.ts server/src/analyzer/gemini.test.ts server/src/routes/failure-taxonomy.ts server/src/routes/failure-remediations.ts server/src/routes/failure-taxonomy.test.ts openapi.yaml src/lib/api-types.ts src/data/help-failures.ts src/data/help-failures.test.ts src/data/help-categories.test.ts
git commit -m "feat(server,openapi,frontend): fail reasoning overflow instead of splitting (#3084)"
```

**Tests this task could break:**
- wave 1's `runner/finish` / characterisation tests. Any empty-`length` case with reasoning evidence changes class, and that case did not exist before wave 2;
- wave 1's `finish.test.ts` case `ollama EMPTY length is still the empty-response Error…`, which is replaced in Step 1. This is the deliberate Ollama ordering change;
- `transports/ollama-transport.test.ts` (wave 1 Task 1.8). Its empty-stream case already expects `finish: 'length'` and `receivedBytes: 0`, and stays green; its `toEqual` results now also carry `reasoningSeen: false` from the variable, which is unchanged;
- `ollama.test.ts:650` `throws plain Error on empty body`. It stays green: it feeds `ndjsonStream([])` with no `done` line, so `doneReason` is `undefined`, `finish` is `'stop'`, and `mapFinish` still throws the empty-response error;
- the chunker suites;
- `review-run.test.ts`;
- `failure-taxonomy.test.ts`;
- the help tests and the `help.tsx` view.

### Task 2.11: Ship PR 2b

**Files:**
- Modify: `server/.env.example` (managed block, via `config:sync`)
- Modify: `docs/release-notes-next.md` (section `## 🗣️ Analyzer, script review & manuscript`, `:284`)
- Modify: `RELEASE_NOTES.md` (top of the `# Castwright 1.15.0` bullet list)
- Modify: `docs/testing/3084-openai-analyzer-onbox-acceptance.md` (append §2, §3)
- Modify: `docs/testing/onbox-acceptance-register.md`:
  - "At a glance" table `:554-566`;
  - "Last change" block `:570`;
  - `## Group B` `:4507-4553`;
  - `## Group E` `:4924-…`.
- Modify: `docs/testing/onbox-acceptance-register-live-view.html` (`#gb` `:728-753`, `#ge` `:1019-…`)

**Row ids.** Each row's id is the next id from that group's `next-id` marker (Group B's at `:4509`, Group E's at `:4926` on 2b63b451), minted at ship time (`npm run check:onbox-register`). Below, `B<next>` and `E<next>` (`B&lt;next&gt;` / `E&lt;next&gt;` inside HTML) stand for the minted Group B and Group E ids. Write the minted ids in their place everywhere, and bump each marker by one in the same commit.

**Group choice.**
- **"Capacity recalibration" → Group B** ("local Ollama analyzer only, no TTS sidecar"). It needs the 16 GB card and Ollama.
- **"Thinking-model output" → Group E** ("not the GPU box"). It needs only a Gemini key and a real chapter.

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
- `config:sync` rewrites only the managed block of `server/.env.example`: the `ANALYZER_MAX_OUTPUT_TOKENS` line's default becomes 0 (and, in Branch B, an `ANALYZER_GEMINI_REQUEST_CEILING_MS` entry is added);
- `config:check` PASS;
- `src/lib/api-types.ts` unchanged since Task 2.10's commit.

Commit:
```bash
git add server/.env.example
git commit -m "chore(server): sync .env.example for Gemini output knobs (#3084)"
```
Settings rows need no frontend change: `src/views/advanced.tsx` renders every knob from `GET /api/config` descriptors.
- [ ] **Step 2: Release notes (both files)**

`docs/release-notes-next.md`, appended as the last bullet of `## 🗣️ Analyzer, script review & manuscript`. Use the real PR numbers of 2a and 2b.
```markdown
- **Gemini output cap is Auto, thinking stays visible, and reasoning overflow is its own failure** — `analyzer.gemini.maxOutputTokens` (`ANALYZER_MAX_OUTPUT_TOKENS`) now defaults to `0` = Auto: the model's `outputTokenLimit` from a 10-minute cached `models.list()` (`catalog/gemini-catalog.ts`), `8192` when the listing is unavailable; an explicit value keeps its meaning and is clamped to the listed limit. Thinking Gemini models request `thinkingConfig.includeThoughts`, so thought parts feed the chunk heartbeat and `thoughtsTokenCount` is recorded as reasoning tokens. A `length`/`MAX_TOKENS` finish with no answer text and reasoning evidence fails as `analyzer-reasoning-overflow` instead of splitting; an empty `MAX_TOKENS` with no evidence (Gemma) still splits. An empty Ollama response at the output limit now splits the chunk (or fails as reasoning overflow when the model was thinking) instead of failing as an empty response. Chunk budgets now resolve from an `EngineCapacity` descriptor, pinned byte-identical by a fixture captured from `main`. (#<2a>, #<2b>, #3084)
```
In **Branch B** only, add this sentence before the PR refs: `Gemini's idle watchdog now starts at the first chunk; the silent wait before it is bounded by analyzer.gemini.requestCeilingMs (ANALYZER_GEMINI_REQUEST_CEILING_MS, 30 min) and fails as analyzer-timeout.`

`RELEASE_NOTES.md`, a new first bullet under `# Castwright 1.15.0`:
```markdown
- **A Gemini model that thinks before it answers no longer stalls on a long chapter.** Some Gemini models reason before replying, and that reasoning counted against a fixed 8,192-token reply limit — so on a big chapter the model could spend its whole allowance thinking and hand back nothing, and Castwright would keep cutting the chapter into smaller pieces without ever getting an answer. Castwright now lets each Gemini model reply up to its own limit, keeps showing activity while the model is thinking, and when a model genuinely runs out of room while reasoning it says so plainly — and names the setting to raise — instead of retrying. The same goes for a local model that hits its output limit before writing any answer: Castwright now splits the chapter, or tells you the model ran out of room while thinking, instead of reporting an empty reply. If you already set your own Gemini output limit, Castwright keeps it.
```
In **Branch B** only, append to that bullet: ` If a request goes quiet for longer than half an hour before it starts answering, Castwright stops it and tells you which setting controls that limit.`
- [ ] **Step 3: Run sheet sections**

Append to `docs/testing/3084-openai-analyzer-onbox-acceptance.md`:
```markdown
---

## 2. Thinking-model output with Auto max output tokens — register row E<next>

**Hardware:** any machine with a Gemini API key; no GPU. **Quota:**
`gemini-3.6-flash` allows 20 requests a day, and this section runs one chapter
twice (Auto, then the 8192 baseline). Start on a fresh daily quota.

### Preconditions

- [ ] A book with one chapter of 19,000–21,000 characters (the reporter's was
      20,000). Record its title, chapter id and exact character count.
- [ ] `ANALYZER_MAX_OUTPUT_TOKENS` is unset in `server/.env`, and Advanced
      Settings has no override for "Gemini max output tokens" (Auto).
- [ ] §1's `Branch:` is recorded. Note which branch shipped.
- [ ] The app is started with `npm start`, so that `logs/server.log` is written.

### Procedure

1. Analyse the chapter with `gemini-3.6-flash` at Auto.
2. From `logs/server.log` and the Analysing view, record:
   - the time from Start to the first streamed chunk;
   - whether the chunk heartbeat moved while the model was thinking;
   - every `[gemini] stream idle` line;
   - every `output truncated` line;
   - any `analyzer-reasoning-overflow` chapter failure (and, in Branch B, any
     `analyzer-timeout`);
   - the number of Gemini requests the chapter took (AI Studio's RPD counter
     before and after).
3. Set Advanced Settings → "Gemini max output tokens" to `8192`, re-run the
   same chapter, and record the same fields.
4. Clear the override (back to Auto).

### Pass

- Auto completes the chapter with no idle retry during thinking and no
  reasoning-overflow failure.
- Auto uses no more requests than the 8192 run.
- A truncation or overflow in the 8192 run is the baseline being recorded, not
  a failure of this row.

### Result

Auto — Result:

8192 baseline — Result:

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
1. **Group B.** Directly before `---` at the end of `## Group B` (after B1, `:4552`), insert:
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
3. **Group E.** At the end of `## Group E`, after its last row and before the next `---`, insert:
```markdown
### E<next> · A thinking Gemini model completes a 20,000-character chapter with Auto output ([#3084](https://github.com/dudarenok-maker/Castwright/issues/3084), wave 2) · **any machine with a Gemini key; no GPU**

Wave 2 made three changes to Gemini analysis:

- the output cap is Auto (the model's own limit, not 8192);
- thinking models are asked for thought summaries;
- an empty `MAX_TOKENS` response with reasoning evidence fails as `analyzer-reasoning-overflow` instead of splitting.

Unit tests drive all three against a mocked stream. Only a real `gemini-3.6-flash` run proves the #3084 reporter's stall is gone.

On a 19,000–21,000-character chapter, record time to first chunk, whether the heartbeat moves during thinking, idle retries, truncations, reasoning-overflow failures and request count. Record them once at Auto and once at `8192`.

**Pass:** Auto completes with no thinking-caused idle retry and no overflow, using no more requests than the 8192 run.

Criteria and result lines: [`3084-openai-analyzer-onbox-acceptance.md` §2](3084-openai-analyzer-onbox-acceptance.md).
```
4. **Group E marker.** Change the Group E marker from `<!-- next-id: E<next> -->` to the id after `E<next>`.
5. **At a glance.** In the table, add 1 to the **B** and **E** rows' counts. Add 2 to the `**N owed.**` total on the line after the table.
6. **Last change.** Replace the current `> **Last change: …**` blockquote's first line with a new blockquote. Date it with today's date. For N, use the owed total read from the file before step 5. Its text:
```markdown
> **Last change: <today> (#3084 wave 2b), N → N+2.** Rows **B<next>** (capacity recalibration — the measurement owed before any capacity default changes) and **E<next>** (a thinking Gemini model on a 20,000-character chapter at Auto output) added from #3084 wave 2's run sheet (`3084-openai-analyzer-onbox-acceptance.md` §2–§3). Group B and Group E `next-id` markers each bumped by one.
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
2. **Group E.** In `<section class="group" id="ge">`, insert before its closing `</section>`:
```html
    <details class="item">
      <summary><span class="num">E&lt;next&gt;</span><span class="iname">A thinking Gemini model completes a 20,000-character chapter with Auto output (#3084 wave 2)</span><span class="risk hot">The reporter's stall</span><span class="chev">›</span></summary>
      <div class="body">
        <p>Wave 2 made Gemini's output cap Auto (the model's own limit, not 8192), asks thinking models for thought summaries, and fails an empty <code>MAX_TOKENS</code> response with reasoning evidence as <code>analyzer-reasoning-overflow</code> instead of splitting. Unit tests drive all three against a mocked stream; only a real <code>gemini-3.6-flash</code> run proves the reporter's stall is gone.</p>
        <ul>
          <li>On a 19,000–21,000-character chapter at <b>Auto</b>: time to first chunk, whether the heartbeat moves during thinking, idle retries, truncations, reasoning-overflow failures, request count.</li>
          <li>The same chapter at <b>8192</b> (Advanced Settings → Gemini max output tokens) as the baseline.</li>
          <li><b>Pass:</b> Auto completes with no thinking-caused idle retry and no overflow, using no more requests than the 8192 run.</li>
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
Expected: every command PASS. If `register:build` rewrote the `gcount` spans ("2 rows", "8 rows") and the summary strip, those changes are part of the commit.
4. **Publish.** Immediately before publishing:
   1. Read the live page with the `Artifact` tool (`action: "read"`, `url: https://claude.ai/code/artifact/adf22b7b-12dd-49fe-874c-4a340585b26a`); it returns the page's raw HTML saved to a local file.
   2. Run `npm run check:onbox-register -- --against-published <that file>`. Expected: PASS; the two new rows (`B<next>`, `E<next>`) are reported as rows your register adds, which is the reason for publishing.
   3. Publish with the `Artifact` tool: `file_path` = this worktree's absolute `docs/testing/onbox-acceptance-register-live-view.html`, `url` = the URL above. Never publish the `.md`, and never publish without `url`.
- [ ] **Step 6: Verify**
Run: `npm run verify:fast:branch`  Expected: PASS.
- [ ] **Step 7: Push and open the PR**
```bash
git push -u origin feat/server-3084-w2b-output-cap
gh pr create --title "feat(server,openapi,frontend): Gemini Auto output tokens, thought visibility, reasoning overflow (#3084 wave 2b)" --body-file <path-to-body.md>
```
Body:
```markdown
## Summary
- **Gemini catalog** (`server/src/analyzer/catalog/gemini-catalog.ts`): `models.list` filtered to `generateContent` text models, cached 10 min per key, warmed through `ChatTransport.prepare()` before the runner reads settings; a failed listing falls back to 12000 cap / 8192 output.
- **Auto max output tokens:** `analyzer.gemini.maxOutputTokens` default `0` = Auto (listed `outputTokenLimit`, else 8192), max lifted to 1048576, explicit values kept and clamped to the listed limit; the runner passes the resolved cap to both transports (Ollama keeps `numPredict`).
- **Thinking visibility:** thinking models request `thinkingConfig.includeThoughts`; thought parts feed the heartbeat; `thoughtsTokenCount` → `usage.reasoningTokens`.
- **Run sheet §1 branch: <A|B>.** <Branch A: pre-first-chunk idle watchdog kept, pinned with streamed thought parts. | Branch B: idle watchdog arms at the first chunk; `analyzer.gemini.requestCeilingMs` (30 min) bounds the silent wait → `AnalyzerTimeoutError` / `analyzer-timeout` (pulled forward from wave 3).>
- **Reasoning overflow:** `length` + no answer text + reasoning evidence → `AnalyzerReasoningOverflowError` / `analyzer-reasoning-overflow` (no split); an empty `MAX_TOKENS` with no evidence (Gemma) still splits. Ollama now applies the same rule to an empty `done_reason: length` stream (previously the empty-response error), with `reasoningSeen` from `message.thinking`.
- **On-box:** register rows **B<next>** (capacity recalibration) and **E<next>** (thinking-model output) — write the minted ids — run sheet §2–§3, live view republished.

Also fixed, found in passing: `server/.env.example:293,301` stated the old 8192 default; `gemini.ts:62-64` comment named the removed `resolveMaxOutputTokens`.

## Test plan
- [ ] `gemini-catalog.test.ts`, `capacity.test.ts`, `gemini-transport-thinking.test.ts`, `finish-reasoning-overflow.test.ts`, `ollama-transport-overflow.test.ts`, chunker no-split pins, `failure-taxonomy.test.ts`, help counts
- [ ] `gemini.test.ts` (slow) Auto wiring + overflow end to end; `ollama.test.ts` num_predict wiring
- [ ] `capacity-pinning.test.ts` green, fixture untouched
- [ ] mutation proofs pasted (Tasks 2.6–2.10)
- [ ] `npm run openapi:types`, `npm run config:check`, `npm run check:onbox-register`, `npm run verify:fast:branch`
- [ ] On-box: owed as register rows B<next> and E<next> (the minted ids; not run in this PR)

Refs #3084

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_013DFfsAoY1LtxjDgnGPSZkc
```
Before pushing, replace the two `<…>` alternatives with the executed branch's text.
- [ ] **Step 8: Review gate.** Run the `pr-review-gate` skill at depth **high** (the PR spans the server, openapi, frontend and docs scopes). The reviewer confirms that run sheet §1 carries a filled `Branch:` line matching the executed task. Fold findings, then re-run per the skill before merging.
