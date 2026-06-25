# Phase 3 prosody annotation + script-review chunking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop script review from silently failing on normal-sized chapters, make it work on huge (Cyrillic) chapters via a sentence-chunker, and auto-generate per-line prosody annotations as a gated post-analysis pass.

**Architecture:** Three independent PRs. PR1 surfaces a dropped SSE event (client only). PR2 adds a server sentence-chunker (owned-core ownership rule) consumed by script-review. PR3 (gate redesigned post-fs-66) auto-triggers the existing annotation routes (through PR2's chunker) after analysis via a single reactive effect gated on a nullable per-book `prosodyEnabled` intent flag OR a cast-derived 1.7B signal (the cast-time safety net), deduped by a completion watermark.

**Tech Stack:** Vite + React 18 + Redux Toolkit (frontend, Vitest + jsdom); Node/Express + TypeScript (server, Vitest + node env); Playwright (e2e). SSE for streamed analyzer passes.

**Spec:** `docs/superpowers/specs/2026-06-25-phase3-prosody-and-scriptreview-chunking-design.md` (read it; adversarial rounds 1+2 are folded there — do not re-derive the architecture).

## Global Constraints

- **OpenAPI is the type source of truth** — `Character`/`Chapter`/`Sentence` come from `src/lib/api-types.ts` (generated). Don't hand-write them.
- **Design tokens are CSS custom properties** — no hex literals in component code (`--peach`, `--ink`, `--magenta`).
- **RTK immer** — slice reducers mutate via Immer drafts. Don't rewrite to spreads.
- **Mocks behind `VITE_USE_MOCKS`** — components import only from `api.*`. Every new `real*` API fn needs a `mock*` twin registered in the api object.
- **Commit convention:** `<type>(<scope>): <subject>`. End every commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **One branch = one PR.** PR1 `fix/frontend-scriptreview-chapter-failed`; PR2 `feat/server-analyzer-chapter-chunker`; PR3 `feat/analysis-phase3-prosody`. Cut each off the latest `origin/main`.
- **Verify gates:** frontend `npm test`; server `cd server && npm run test`; full `npm run verify` before each PR push.
- **PR3 gate (post-fs-66):** fs-66 ("1.7B implies prosody") has merged — synth gate is `is17b` alone, the "go 1.7B" decision is the cast `ttsModelKey`. PR3 renames the orphaned `liveInstruct` flag to a nullable `prosodyEnabled` intent flag (Task 11) and MUST NOT introduce any competing book-quality flag. There is no concurrent session to reconcile with; just cut off latest `origin/main`.

---

## PR1 — Surface `chapter-failed` (branch `fix/frontend-scriptreview-chapter-failed`)

Root cause (spec §2A): `realReviewScript`'s `handle()` has no `chapter-failed` case, so a too-large/failed chapter is dropped and the modal opens empty with no error.

### Task 1: `realReviewScript` surfaces `chapter-failed`

**Files:**
- Modify: `src/lib/api.ts` — `ReviewScriptOpts` (lines 2893–2900) + `realReviewScript`'s `handle()` (the switch ~lines 2922–2961) + `mockReviewScript` twin.
- Test: `src/lib/api-review-script.test.ts` (create; colocated unit test driving the SSE parser via a fake `fetch`).

**Interfaces:**
- Produces: `ReviewScriptOpts.onChapterFailed?: (e: { chapterId: number; message: string }) => void`.

- [ ] **Step 1: Write the failing test** — a `chapter-failed`-only stream calls `onChapterFailed`, still resolves (no throw), `totalOps === 0`.

```ts
// src/lib/api-review-script.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

function sseResponse(events: string[]): Response {
  // jsdom-safe: ReadableStream + TextEncoder (Blob.stream() is unreliable in jsdom;
  // this mirrors the existing src/lib/api-detect-emotions.test.ts pattern).
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (const e of events) c.enqueue(encoder.encode(`data: ${e}\n\n`)); c.close(); },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('realReviewScript — chapter-failed is surfaced', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('calls onChapterFailed and still resolves on a chapter-failed-only stream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({ kind: 'phase', phaseId: 0, progress: 0, label: 'Reviewing — chapter 2', chapterId: 2 }),
      JSON.stringify({ kind: 'chapter-failed', chapterId: 2, message: 'Chapter 2 is too large — split it first.' }),
      JSON.stringify({ kind: 'result', done: true, reviewedChapters: 0, totalOps: 0 }),
    ])));
    const { api } = await import('./api');
    const failed: Array<{ chapterId: number; message: string }> = [];
    const res = await api.reviewScript('bk', { chapterId: 2, onChapterFailed: (e) => failed.push(e) });
    expect(failed).toEqual([{ chapterId: 2, message: 'Chapter 2 is too large — split it first.' }]);
    expect(res.totalOps).toBe(0);
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `npm test -- src/lib/api-review-script.test.ts` → FAIL (`onChapterFailed` never called).

- [ ] **Step 3: Implement** — add the field + the case.

```ts
// ReviewScriptOpts (add one line):
  onChapterFailed?: (e: { chapterId: number; message: string }) => void;

// inside handle()'s switch in realReviewScript, add:
      case 'chapter-failed':
        if (typeof p.chapterId === 'number') {
          onChapterFailed?.({
            chapterId: p.chapterId,
            message: typeof p.message === 'string' ? p.message : 'Chapter review failed.',
          });
        }
        break;
```
Destructure `onChapterFailed` in the `realReviewScript` opts signature. In `mockReviewScript`, accept (and ignore) `onChapterFailed` so types match.

- [ ] **Step 4: Run it, verify it passes** — `npm test -- src/lib/api-review-script.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/api-review-script.test.ts
git commit -m "fix(frontend): surface chapter-failed in realReviewScript SSE handler"
```

### Task 2: `handleReviewScript` shows a toast instead of an empty modal

**Files:**
- Modify: `src/views/manuscript.tsx` — `handleReviewScript` (lines 672–719).
- Test: `src/views/manuscript-review-chapter-failed.test.tsx` (create).

**Interfaces:**
- Consumes: `api.reviewScript(..., { onChapterFailed })`; `notificationsActions.pushToast({ kind, message })` (`'error'|'warn'|'info'`).

- [ ] **Step 1: Write the failing test** — render the manuscript review trigger with `api.reviewScript` mocked to emit one `chapter-failed` and zero ops; assert a toast is dispatched and `hasActiveReview` stays false (no modal).

```tsx
// src/views/manuscript-review-chapter-failed.test.tsx
// Arrange a store + a mocked api.reviewScript that calls opts.onChapterFailed once and resolves {reviewedChapters:0,totalOps:0}.
// Click the "Review Script" button (data-testid="review-script-chapter").
// Assert: notifications slice has 1 toast whose message includes "too large";
//         scriptReview.byBook[bookId] is undefined (no empty bucket / no modal).
```
(Full arrange/act/assert mirrors the existing `src/components/detect-emotions-button.test.tsx` store-harness pattern; mock `../lib/api`'s `reviewScript`.)

- [ ] **Step 2: Run it, verify it fails** — `npm test -- manuscript-review-chapter-failed` → FAIL (today it dispatches an empty `setReview`, opening the modal).

- [ ] **Step 3: Implement** — collect failures, branch on ops vs failures.

```ts
// in handleReviewScript, before the try: const failed: Array<{chapterId:number;message:string}> = [];
// pass to api.reviewScript opts: onChapterFailed: (e) => failed.push(e),
// after planApply, REPLACE the unconditional dispatch(setReview(...)) with:
      if (appliable.length === 0 && unappliable.length === 0 && failed.length > 0) {
        dispatch(notificationsActions.pushToast({
          kind: 'warn',
          message: failed.length === 1
            ? failed[0].message
            : `${failed.length} chapters couldn't be reviewed (too large or failed).`,
        }));
      } else {
        if (failed.length > 0) {
          dispatch(notificationsActions.pushToast({ kind: 'warn', message: `${failed.length} chapter(s) skipped; showing the rest.` }));
        }
        dispatch(scriptReviewActions.setReview({ bookId, ops: appliable, unappliable }));
      }
```

- [ ] **Step 4: Run it, verify it passes** — `npm test -- manuscript-review-chapter-failed` → PASS. Then `npm test -- manuscript` to confirm no regression in existing review tests.

- [ ] **Step 5: Commit**

```bash
git add src/views/manuscript.tsx src/views/manuscript-review-chapter-failed.test.tsx
git commit -m "fix(frontend): toast on script-review chapter-failed instead of empty modal"
```

### Task 3: PR1 verify + open

- [ ] `npm run verify` (frontend leg green). Rebase on `origin/main`. Push `fix/frontend-scriptreview-chapter-failed`. Open PR titled `fix(frontend): surface script-review chapter-failed instead of a silent empty modal`, body links the spec §2A + `Closes #1124`. **(SHIPPED — PR #1126.)**

---

## PR2 — Sentence-chunker + script-review chunking (branch `feat/server-analyzer-chapter-chunker`)

Root cause (spec §2B): the borrowed 9 K guard refuses normal chapters; Dozor chapters are 3–5× local `num_ctx`. Reuse only the budget helper; window sentence-objects with an owned-core ownership rule.

### Task 4: `chapter-chunker.ts` — sentence windowing + ownership

**Files:**
- Create: `server/src/analyzer/chapter-chunker.ts`.
- Test: `server/src/analyzer/chapter-chunker.test.ts`.

**Interfaces:**
- Consumes: `stage1ChunkBudgetForEngine(configured, numCtxTokens, engine)` (`stage1-chunk.ts:48`), `resolveAnalyzerNumCtx()` (`ollama.ts:216`).
- Produces:
```ts
export interface SentenceChunk<S> { core: S[]; context: S[]; coreIds: Set<number>; }
// `withContext` = context-before + core + context-after, in order, for prompt building.
export function chunkSentencesByBudget<S extends { id: number; text: string }>(
  sentences: S[],
  opts: { charBudget: number; overlap: number; serialize: (s: S) => string },
): SentenceChunk<S>[];
export function chunkWithContext<S>(chunk: SentenceChunk<S>): S[]; // context-before ++ core ++ context-after
export function ownsOp(coreIds: Set<number>, primaryId: number): boolean; // primaryId in core
export function primarySentenceId(op: { id: number; op: string; mergeIds?: number[] }): number; // min(mergeIds) for merge, else id
export function chapterChunkBudget(engine: 'gemini' | 'local'): number; // = resolveStage1ChunkCharBudget(engine) — already num_ctx-derived for local, MAX_SAFE_INTEGER for gemini
```

- [ ] **Step 1: Write the failing test** — windowing, overlap, owned-core, ownership.

```ts
// server/src/analyzer/chapter-chunker.test.ts
import { describe, it, expect } from 'vitest';
import { chunkSentencesByBudget, chunkWithContext, ownsOp, primarySentenceId } from './chapter-chunker.js';

const S = (id: number, len = 10) => ({ id, text: 'x'.repeat(len) });

describe('chunkSentencesByBudget', () => {
  it('cores partition the sentences with no gaps or overlaps', () => {
    const sents = Array.from({ length: 10 }, (_, i) => S(i + 1, 30));
    const chunks = chunkSentencesByBudget(sents, { charBudget: 90, overlap: 1, serialize: (s) => s.text });
    const cores = chunks.flatMap((c) => c.core.map((s) => s.id));
    expect(cores).toEqual([1,2,3,4,5,6,7,8,9,10]);          // every sentence owned once
    expect(chunks.length).toBeGreaterThan(1);                // multi-chunk forced by budget
  });
  it('context overlaps neighbours but is excluded from coreIds', () => {
    const sents = Array.from({ length: 6 }, (_, i) => S(i + 1, 40));
    const chunks = chunkSentencesByBudget(sents, { charBudget: 80, overlap: 1, serialize: (s) => s.text });
    const second = chunks[1];
    expect(chunkWithContext(second).length).toBeGreaterThan(second.core.length); // has context
    for (const s of second.core) expect(second.coreIds.has(s.id)).toBe(true);
    expect([...second.coreIds].some((id) => chunks[0].coreIds.has(id))).toBe(false); // disjoint cores
  });
});

describe('ownership', () => {
  it('primarySentenceId is min(mergeIds) for merge, else id', () => {
    expect(primarySentenceId({ id: 0, op: 'merge', mergeIds: [7, 5, 6] })).toBe(5);
    expect(primarySentenceId({ id: 9, op: 'strip_tag' })).toBe(9);
  });
  it('ownsOp is true only when the primary id is in the core', () => {
    const core = new Set([5, 6]);
    expect(ownsOp(core, 5)).toBe(true);
    expect(ownsOp(core, 7)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `cd server && npm run test -- chapter-chunker` → FAIL (module missing).

- [ ] **Step 3: Implement** — greedy accumulation by serialized char length; cores are disjoint contiguous runs; context = `overlap` sentences each side (clamped); ownership helpers as specified. `chapterChunkBudget(engine)` returns `resolveStage1ChunkCharBudget(engine)` **directly** — it already derives from `num_ctx` for `'local'` and returns `Number.MAX_SAFE_INTEGER` for `'gemini'`; do NOT re-wrap it in `stage1ChunkBudgetForEngine` (that double-derives and corrupts the budget). `chunkSentencesByBudget` stays a pure function over the sentence array (no I/O); only `chapterChunkBudget` reads config.

- [ ] **Step 4: Run it, verify it passes** — `cd server && npm run test -- chapter-chunker` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/chapter-chunker.ts server/src/analyzer/chapter-chunker.test.ts
git commit -m "feat(server): sentence-chunker with owned-core ownership rule"
```

### Task 5: script-review consumes the chunker

**Files:**
- Modify: `server/src/routes/script-review.ts` — the per-chapter loop (lines 204–234): remove the `DEFAULT_STAGE2_CHUNK_CHAR_BUDGET` guard; loop chunks; emit owned-core ops only.
- Test: `server/src/routes/script-review.test.ts` (extend).

**Interfaces:**
- Consumes: `chunkSentencesByBudget`, `chunkWithContext`, `ownsOp`, `primarySentenceId`, `chapterChunkBudget` (Task 4); `buildScriptReviewChapterInbox` (existing); `selection.analyzer.runScriptReviewChapter` (`analyzer/index.ts:100`); `selection.engine` (`'local'|'gemini'`).

- [ ] **Step 1: Write the failing test** — with `num_ctx` forced low (stub `resolveAnalyzerNumCtx` → e.g. 800) and a multi-sentence chapter, the route emits chunked `ops` with **no** `chapter-failed`, and an op whose `primarySentenceId` is NOT in any chunk's core is dropped (ownership). Assert each sentence id appears in ops at most once.

```ts
// extend server/src/routes/script-review.test.ts
// Mock the analyzer's runScriptReviewChapter to echo one strip_tag op per sentence id present in the chunk prompt.
// Force a small budget so the chapter splits into >=2 chunks.
// Expect: union of emitted op ids == chapter sentence ids (each once); zero 'chapter-failed' events.
```

- [ ] **Step 2: Run it, verify it fails** — `cd server && npm run test -- script-review` → FAIL (today: single call + 9 K guard).

- [ ] **Step 3: Implement** — replace the guard+single-call body:

```ts
const chunks = chunkSentencesByBudget(byChapter.get(chapterId) ?? [], {
  charBudget: chapterChunkBudget(selection.engine),
  overlap: 3,
  serialize: (s) => JSON.stringify({ id: s.id, characterId: s.characterId, text: s.text }),
});
for (const chunk of chunks) {
  if (closed) break;
  const prompt = buildScriptReviewChapterInbox(manuscriptId, chapterId, chunkWithContext(chunk), roster);
  try {
    const result = await selection.analyzer.runScriptReviewChapter(manuscriptId, chapterId, prompt, { /* same call opts */ });
    const owned = result.ops.filter((op) => ownsOp(chunk.coreIds, primarySentenceId(op)));
    if (owned.length) { send({ kind: 'ops', chapterId, ops: owned }); totalOps += owned.length; }
  } catch (err) { /* keep existing catch: AnalysisAbortedError break; DailyQuotaExhaustedError → error+return; else chapter-failed (now genuinely-impossible single-sentence case) */ }
}
reviewedChapters += 1;
```
Remove the `DEFAULT_STAGE2_CHUNK_CHAR_BUDGET` import + guard. Keep the `result` event and SSE plumbing unchanged.

- [ ] **Step 4: Run it, verify it passes** — `cd server && npm run test -- script-review` → PASS. Run `cd server && npm run test -- chapter-chunker script-review` together.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/script-review.ts server/src/routes/script-review.test.ts
git commit -m "feat(server): script review chunks large chapters via owned-core chunker"
```

### Task 6: PR2 verify + open

- [ ] `npm run verify` (server + server-slow legs). Rebase on `origin/main`. Push `feat/server-analyzer-chapter-chunker`. PR title `feat(server): chunk script review over large chapters (owned-core sentence chunker)`, body links spec §2B + shared-component section + `Closes #1127`. **(SHIPPED — PR #1128.)**

---

## PR3 — Phase 3 prosody annotation (branch `feat/analysis-phase3-prosody`)

> **GATE REDESIGNED (2026-06-25) — ready to execute.** PR1 (#1126) and PR2
> (#1128) shipped. fs-66 ("1.7B implies prosody", PR #1136) has now landed on
> `main`: the synth prosody gate is `is17b` alone, `liveInstruct` is orphaned
> plumbing (set by no UI, read at no synth site), and the "go 1.7B" decision is a
> **cast-time** signal (`ttsModelKey === 'qwen3-tts-1.7b'`, per-character or via
> the book bulk-pin `POST /cast/tier`). Tasks 7–10 + 14 are unchanged. The gate
> tasks are redesigned below: **Task 11 (new)** renames `liveInstruct` →
> `prosodyEnabled`; **Task 12** is the smart-default analysis-form toggle;
> **Task 13** is the single reactive auto-trigger whose cast dependency IS the
> cast-time safety net. See the spec's "Gate model" section (read it — the
> tri-state flag + cast-derived auto-rule are folded there).

**PREREQUISITE — satisfied.** Task 8 imports `server/src/analyzer/chapter-chunker.ts`, which landed with PR2 (#1128, merged). **Cut `feat/analysis-phase3-prosody` off the latest `origin/main`** (which now contains both PR2 and fs-66).

**No coordination gate.** The concurrent book-1.7B work (fs-66) is merged; it did **not** introduce a `bookQualityOverride` flag — the override is the cast `ttsModelKey` written by `POST /cast/tier`. Do NOT add any competing book-quality flag; the only intent flag is `prosodyEnabled` (Task 11).

### Task 7: book-state `prosodyAnnotated` watermark

**Files:**
- Modify: `server/src/workspace/scan.ts` (`BookStateJson`, near the existing `liveInstruct?` / `prosodyEnabled?` boolean field at lines 230–236); `server/src/routes/book-state.ts` (the `case 'state':` patch handler, lines 605–765).
- Test: `server/src/routes/book-state.test.ts` (extend).

**Interfaces:**
- Produces: `BookStateJson.prosodyAnnotated?: boolean` — true once both prosody passes complete for the book; the auto-trigger fires only when absent/false. **Distinct from the `prosodyEnabled` intent flag (Task 11): `prosodyEnabled` = "should we annotate", `prosodyAnnotated` = "annotation finished".**

- [ ] **Step 1: Write the failing test** — `PUT /api/books/:bookId/state {patch:{prosodyAnnotated:true}}` persists the field; an absent/non-boolean patch leaves it unchanged.
- [ ] **Step 2: Run, verify fail** — `cd server && npm run test -- book-state` → FAIL.
- [ ] **Step 3: Implement** — add the optional field (JSDoc, additive — do NOT bump `CURRENT_STATE_SCHEMA`, mirror the existing single-boolean field's note) + a boolean picker in the `case 'state':` spread (mirror the existing single-boolean ternary in that handler).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(server): prosodyAnnotated watermark on book state`.

### Task 8: annotation routes consume the chunker

**Files:**
- Modify: `server/src/routes/instruct-annotation.ts` (per-chapter loop, lines 129–186 — builds `buildInstructChapterInbox(...)`, calls `selection.analyzer.runStage3Chapter(...)`, then `send({kind:'annotation', chapterId, annotations: result.annotations})`).
- Modify: `server/src/routes/annotate-emotion.ts` (the structurally-identical sibling loop — builds `buildEmotionChapterInbox(...)`, calls `selection.analyzer.runEmotionChapter(...)`, same `send({kind:'annotation',...})`). Both verified same shape by review.
- Test: `server/src/routes/instruct-annotation.test.ts`, `server/src/routes/annotate-emotion.test.ts` (extend).

**Interfaces:**
- Consumes: PR2's `chunkSentencesByBudget`/`chunkWithContext`/`chapterChunkBudget` (`chapter-chunker.ts` — requires PR2 merged, see PREREQUISITE); annotation ownership is `chunk.coreIds.has(ann.sentenceId)` (no structural ops — annotations are per-sentence, so no `primarySentenceId` needed here).

- [ ] **Step 1: Write the failing test** — stub `resolveAnalyzerNumCtx` low + `selection.engine='local'`; a multi-sentence chapter splits into ≥2 chunks; each sentence's annotation is emitted exactly once (owned-core), zero `chapter-failed`/truncation. Assert the union of emitted `sentenceId`s == the chapter's sentence ids, each once.
- [ ] **Step 2: Run, verify fail** — `cd server && npm run test -- instruct-annotation annotate-emotion` → FAIL.
- [ ] **Step 3: Implement** — in EACH route, replace the single-call body inside the per-chapter loop with a per-chunk loop (identical shape in both; only the inbox builder + analyzer method name differ):

```ts
const sentences = byChapter.get(chapterId) ?? [];
const chunks = chunkSentencesByBudget(sentences, {
  charBudget: chapterChunkBudget(selection.engine),
  overlap: 3,
  serialize: (s) => JSON.stringify({ sentenceId: s.id, characterId: s.characterId, text: s.text }),
});
for (const chunk of chunks) {
  if (closed) break;
  const prompt = buildInstructChapterInbox(manuscriptId, chapterId, chunkWithContext(chunk)); // annotate-emotion: buildEmotionChapterInbox
  const result = await selection.analyzer.runStage3Chapter(manuscriptId, chapterId, prompt, { /* same StageCall opts */ }); // annotate-emotion: runEmotionChapter
  const owned = result.annotations.filter((a) => chunk.coreIds.has(a.sentenceId));
  if (owned.length) { send({ kind: 'annotation', chapterId, annotations: owned }); totalAnnotations += owned.length; }
}
annotatedChapters += 1; // once per chapter, after the chunk loop — keep the existing try/catch (chapter-failed) around the loop body
```
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(server): emotion+instruct annotation passes chunk large chapters`.

### Task 9: `chapter-failed` surfaced in detect handlers (the §2A sibling gap)

**Files:**
- Modify: `src/lib/api.ts` — `DetectEmotionsOpts`/`DetectInstructOpts` (+ their `handle()` switches) gain `onChapterFailed`.
- Test: `src/lib/api-detect-emotions.test.ts` (extend).

- [ ] TDD as Task 1, applied to `realDetectEmotions`/`realDetectInstruct`. Commit `fix(frontend): surface chapter-failed in detect-emotions/instruct handlers`.

### Task 10: extract reusable `runProsodyPasses` thunk

**Files:**
- Create: `src/store/prosody-thunk.ts` (the two-pass sequence factored out of `DetectEmotionsButton.run`, lines 38–96).
- Modify: `src/components/detect-emotions-button.tsx` to call it (button behaviour unchanged).
- Test: `src/store/prosody-thunk.test.ts`.

**Interfaces:**
- Produces: `runProsodyPasses(bookId, { dispatch, signal, onProgress? }): Promise<{ totalAnnotations: number; totalChapters: number; failed: number }>` — runs `api.detectEmotions` then `api.detectInstruct`, dispatching `applyDetectedEmotions`/`applyDetectedInstruct`, summing failures via `onChapterFailed`.

- [ ] TDD: test that it calls both api passes in order and dispatches both apply actions; mock `api`. Commit `refactor(frontend): extract runProsodyPasses from DetectEmotionsButton`.

### Task 11: rename `liveInstruct` → `prosodyEnabled` (nullable Phase-3 intent flag)

The fs-66-orphaned `liveInstruct` flag is renamed and repurposed as the Phase-3 intent flag, and its semantics flip from plain-boolean (`?? false`) to **nullable** (undefined = "auto") so the Task-13 gate can distinguish undefined/true/false.

**Files:**
- Modify: `server/src/workspace/scan.ts` — rename `BookStateJson.liveInstruct?` → `prosodyEnabled?` (line 236) + rewrite its JSDoc (it is NO LONGER a synth-path flag — it is the Phase-3 annotation intent flag; undefined ⇒ auto-by-cast).
- Modify: `server/src/routes/book-state.ts` — the `case 'state':` picker that reads `liveInstruct` (lines 706–708) → `prosodyEnabled`.
- Modify: `src/store/book-meta-slice.ts` — rename `liveInstruct` field (55, 61), hydration (94), `setLiveInstruct` (119–120), `selectLiveInstruct` (167–170) to `prosodyEnabled`/`setProsodyEnabled`/`selectProsodyEnabled`. **Flip to nullable:** hydration preserves undefined (`s.prosodyEnabled[bookId] = state.prosodyEnabled` — drop the `?? false`); the selector returns `s.bookMeta.prosodyEnabled[bookId]` with **NO `?? false`** (the gate needs the three states).
- Modify: `src/components/layout.tsx:790` — hydration `liveInstruct: res.state.liveInstruct ?? false` → `prosodyEnabled: res.state.prosodyEnabled` (preserve undefined).
- Modify: `openapi.yaml` — rename the book-state `liveInstruct` property (line 3361) → `prosodyEnabled` + rewrite its description. **Do NOT touch line 4910** (the Sentence `instruct` "Qwen 1.7B liveInstruct path" comment names the synth path, not this flag). Then regenerate: `npm run openapi:types` (updates `src/lib/api-types.ts`).
- Modify tests: `src/store/book-meta-slice.test.ts`, `server/src/routes/book-state.test.ts`, and any `setLiveInstruct`/`selectLiveInstruct` references.

**Interfaces:**
- Produces: `bookMetaActions.setProsodyEnabled({ bookId, value: boolean })`; `selectProsodyEnabled(bookId): (s: RootState) => boolean | undefined`; `BookStateJson.prosodyEnabled?: boolean` (undefined when absent).
- **Do NOT** rename the unrelated `instructHash`/`renderedInstructHashes` "liveInstruct render" comments in `segments-io.ts`/`stale-chapters.ts` — they name the synth path.

- [ ] **Step 1: Enumerate sites** — `git grep -n "liveInstruct\|LiveInstruct" src server/src openapi.yaml` and cross-check against the Files list; set aside the segments-io / stale-chapters synth-path comments.
- [ ] **Step 2: Write the failing test** — extend `book-meta-slice.test.ts`: `selectProsodyEnabled(bookId)` returns `undefined` for an unset book; `true`/`false` after `setProsodyEnabled`; hydrating `{ prosodyEnabled: undefined }` leaves it undefined (NOT coerced to false).
- [ ] **Step 3: Run, verify fail** — `npm test -- book-meta` → FAIL (action/selector not renamed yet).
- [ ] **Step 4: Implement** — perform the rename across the Files list; flip the slice selector + both hydration sites to preserve undefined (the one non-mechanical change); `npm run openapi:types`.
- [ ] **Step 5: Run, verify pass** — `npm test -- book-meta` + `cd server && npm run test -- book-state` + `npm run typecheck` → PASS.
- [ ] **Step 6: Commit** — `refactor: rename liveInstruct flag to nullable prosodyEnabled (Phase-3 intent)`.

### Task 12: analysis-form "Expressive directions (Qwen 1.7B)" toggle (smart default)

**Files:**
- Modify: `src/views/analysing.tsx` (start-analysis surface, near the "Start analysis" button ~line 1172) — add the toggle.
- Test: `src/views/analysing-prosody-toggle.test.tsx`.

**Interfaces:**
- Consumes: `selectProsodyEnabled(bookId)` + `bookMetaActions.setProsodyEnabled` (Task 11); `state.account.defaultTtsModelKey`.

Behaviour:
- **Checked state** = `stored ?? (defaultTtsModelKey === 'qwen3-tts-1.7b')`, where `stored = useAppSelector(selectProsodyEnabled(bookId))`. A 1.7B-default user sees it pre-ticked ("we assume you'll take the quality pass"); a Kokoro user sees it un-ticked. An untouched book stores nothing (undefined = auto).
- **On change:** `dispatch(bookMetaActions.setProsodyEnabled({ bookId, value }))` AND `void api.putBookState(bookId, { slice: 'state', patch: { prosodyEnabled: value } })` for durability. **Do NOT gate the analysis POST on it** — Phase 3 runs after analysis via the client-side Task-13 trigger; the server never reads this during analysis.
- Label "Expressive directions (Qwen 1.7B)"; helper text "Generate per-line emotion + delivery directions for the richer 1.7B voice. Runs in the background after analysis."

- [ ] **Step 1: Write the failing test** — with `defaultTtsModelKey='qwen3-tts-1.7b'` + no stored value → toggle renders **checked**; with a Kokoro default + no stored value → **unchecked**; toggling dispatches `setProsodyEnabled` and issues the PUT carrying the explicit boolean.
- [ ] **Step 2: Run, verify fail** — `npm test -- analysing-prosody-toggle` → FAIL.
- [ ] **Step 3: Implement** the toggle per Behaviour above.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(frontend): expressive-directions toggle on the analysis form (smart default)`.

### Task 13: reactive auto-trigger (intent flag + cast-time safety net) + watermark

**Files:**
- Modify: `src/components/layout.tsx` — add a `useEffect` mirroring the existing voice-match auto-trigger (`layout.tsx:895-917`): `useRef` fired-guard + an `AbortController` cleanup (the voice-match sibling has none — create one here).
- Test: `src/store/prosody-autotrigger.test.tsx`.

**Interfaces:**
- Consumes: `runProsodyPasses` (Task 10); `selectProsodyEnabled` (Task 11); the cast slice; `api.getBookState`/`api.putBookState`.

```tsx
const prosodyEnabled = useAppSelector(selectProsodyEnabled(bookId));        // boolean | undefined
const bookCastIs17b = useAppSelector((s) =>
  (s.cast?.characters ?? []).some((c) => c.ttsModelKey === 'qwen3-tts-1.7b'));
const shouldAnnotate =
  prosodyEnabled === false ? false
  : prosodyEnabled === true ? true
  : bookCastIs17b;                                                          // "auto" / safety-net case

const prosodyFiredFor = useRef<string | null>(null);
useEffect(() => {
  if (stageKind !== 'confirm' && stageKind !== 'ready') { prosodyFiredFor.current = null; return; }
  if (!bookId || !shouldAnnotate) return;          // MUST precede the guard set, so a later flip can still fire
  if (prosodyFiredFor.current === bookId) return;
  prosodyFiredFor.current = bookId;
  const ac = new AbortController();
  (async () => {
    const st = await api.getBookState(bookId);
    if (ac.signal.aborted || st?.state.prosodyAnnotated) return;            // watermark complete → never re-run
    await runProsodyPasses(bookId, { dispatch, signal: ac.signal });
    if (!ac.signal.aborted) void api.putBookState(bookId, { slice: 'state', patch: { prosodyAnnotated: true } });
  })();
  return () => ac.abort();
}, [stageKind, bookId, shouldAnnotate]);
```
- **`shouldAnnotate` is the single gate dependency** — folding `prosodyEnabled` + `bookCastIs17b` into it means a late cast bulk-pin (which flips `bookCastIs17b` true via the cast slice) re-runs the effect → the **cast-time safety net**, with no separate `POST /cast/tier` instrumentation.
- The `if (!shouldAnnotate) return;` **must** come before `prosodyFiredFor.current = bookId` so a book that started ineligible (false) and later flips eligible isn't blocked by a prematurely-set guard.
- `prosodyAnnotated` is NOT hydrated into any slice, so it is fetched inline via `api.getBookState` (`BookStateResponse | null`; read `st?.state.prosodyAnnotated`). The watermark dedupes both trigger paths.

- [ ] **Step 1: Write the failing test** — gate truth-table: `undefined` + 1.7B cast → fires `runProsodyPasses` once; `undefined` + Kokoro cast → never fires; `false` + 1.7B cast → suppressed; `true` + Kokoro cast → fires; `getBookState` returns `{prosodyAnnotated:true}` → fires guard but no `runProsodyPasses`; **late pin: rerender with a 1.7B cast member appended → fires exactly once** (assert call count 1 across the rerender); on completion `putBookState` writes `prosodyAnnotated:true`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** per the shape above.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(frontend): reactive prosody auto-trigger (intent flag + cast-time safety net)`.

### Task 14: global prosody progress pill

**Files:**
- Create: `src/store/prosody-slice.ts` (`activeStream: { bookId, progress, label } | null`), registered in `src/store/index.ts` reducer map only. **The slice is TRANSIENT** — UI-only progress state, like `notifications`: add ONLY the reducer to the map; do NOT add it to `persistence-middleware` or `broadcast-middleware` (no persistence/cross-tab sync). Confirm by grepping `src/store/index.ts` for how `notifications` is wired and match that (reducer-only).
- Modify: `src/components/layout.tsx` (lines ~1209–1251, beside `analysisPill`) to render a `prosodyPill` from `s.prosody.activeStream`; `runProsodyPasses` updates it via `onProgress`.
- Test: `src/store/prosody-slice.test.ts` + `src/components/layout-prosody-pill.test.tsx`.

- [ ] TDD: slice set/clear; pill renders label + percent while active, absent when null. Commit `feat(frontend): global prosody-detection progress pill`.

### Task 15: PR3 e2e + verify + open

- [ ] e2e `e2e/analysis-prosody-toggle.spec.ts`: a 1.7B-default book (or the toggle on) → analysis completes → user reaches cast while the prosody pill runs → annotations land (assert a sentence gains an `instruct`).
- [ ] `npm run verify` (full battery incl. e2e). Rebase on latest `origin/main`. Push `feat/analysis-phase3-prosody`. PR title `feat: auto-generate per-line prosody annotations after analysis (Phase 3)`, body links the spec §Deliverable-1 + the gate-model section + `Closes #1129`.

---

## Self-review notes

- **Spec coverage:** §2A → PR1 Tasks 1–2 + PR3 Task 9 (detect handlers). §2B shared chunker → PR2 Task 4; script-review consumption → Task 5. §Deliverable-1 (gate model): flag rename → Task 11; analysis-form toggle (smart default) → Task 12; reactive auto-trigger + cast-time safety net → Task 13; watermark → Task 7; chunker reuse by annotation passes → Task 8; global-pill surfacing → Task 14; reusable pass → Task 10.
- **Owned-core rule** (the round-2 fix) is centralized in Task 4 and consumed by Tasks 5 + 8 — no `opKey` cross-chunk dedupe anywhere.
- **No 4th in-pipeline phase / no `PHASE_WEIGHTS` edits** (round-2 blast-radius avoided): Phase 3 surfaces via its own `prosody-slice` pill (Task 14), not `ANALYSIS_PHASES`.
- **`prosodyEnabled` is the single intent flag** (Tasks 11–13), nullable (undefined = auto-by-cast). The synth-time gate is `is17b` alone (fs-66) — there is NO competing book-quality flag and NO `bookQualityOverride`; the cast-time signal is `ttsModelKey === 'qwen3-tts-1.7b'`.
- **Two distinct booleans, don't conflate:** `prosodyEnabled` (Task 11 — "should we annotate", nullable intent) vs `prosodyAnnotated` (Task 7 — "annotation finished", watermark).
