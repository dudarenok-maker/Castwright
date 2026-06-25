# Phase 3 prosody annotation + script-review chunking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop script review from silently failing on normal-sized chapters, make it work on huge (Cyrillic) chapters via a sentence-chunker, and auto-generate per-line prosody annotations as a gated post-analysis pass.

**Architecture:** Three independent PRs. PR1 surfaces a dropped SSE event (client only). PR2 adds a server sentence-chunker (owned-core ownership rule) consumed by script-review. PR3 (gate redesigned post-fs-66, eager-default per the 2026-06-25 decision) auto-triggers the existing annotation routes (through PR2's chunker) when a book **transitions to analysis-complete in `library.books`** (active OR background — round-2 Critical), whenever the per-book `prosodyEnabled` flag (read authoritatively from disk) is not `false` (absent ⇒ on), via a seeded, detached, retry-safe effect deduped by a completion watermark. No cast read.

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
- **PR3 gate (post-fs-66, eager-default):** fs-66 ("1.7B implies prosody") has merged — synth gate is `is17b` alone. **Ground truth:** 1.7B is never an account/book default (the picker offers only Qwen 0.6b); it's chosen late (cast bulk-pin or regen override), so there is NO analysis-time 1.7B signal. Decision (2026-06-25): **annotate eagerly by default** — the gate is `prosodyEnabled !== false` (absent ⇒ on), fired when a book transitions to analysis-complete in `library.books` (round-2 re-key: active + background books, not the active `stageKind`). PR3 renames the orphaned `liveInstruct` flag to `prosodyEnabled` (Task 11) and MUST NOT introduce any competing book-quality flag. Cut off latest `origin/main`.

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

> **IMPLEMENTED 2026-06-26.** Tasks 7–14 + the Task-15 e2e are built on
> `feat/analysis-phase3-prosody` (SDD, per-task reviews, a dedicated Task-13
> trigger review, and an Opus whole-branch review — no Critical). Full
> `npm run verify` green (incl. e2e 234 passed). Closes #1129.

> **GATE REDESIGNED (2026-06-25) — ready to execute.** PR1 (#1126) and PR2
> (#1128) shipped. fs-66 ("1.7B implies prosody", PR #1136) has now landed on
> `main`: the synth prosody gate is `is17b` alone, `liveInstruct` is orphaned
> plumbing (set by no UI, read at no synth site), and the "go 1.7B" decision is a
> **cast-time** signal (`ttsModelKey === 'qwen3-tts-1.7b'`, per-character or via
> the book bulk-pin `POST /cast/tier`). Tasks 7–10 + 14 are unchanged. The gate
> tasks are redesigned below: **Task 11 (new)** renames `liveInstruct` →
> `prosodyEnabled` (absent ⇒ on); **Task 12** is the analysis-form toggle
> (checked by default); **Task 13** is the eager auto-trigger keyed on
> `library.books` status transitions (active + background books), seeded,
> detached, retry-safe, authoritative-disk gate (no cast read); **Task 13b**
> adds the opt-out render-time hint. See the spec's "Gate model" section (read
> it — the eager-default decision + round-1 AND round-2 review fixes are folded there).

**PREREQUISITE — satisfied.** Task 8 imports `server/src/analyzer/chapter-chunker.ts`, which landed with PR2 (#1128, merged). **Cut `feat/analysis-phase3-prosody` off the latest `origin/main`** (which now contains both PR2 and fs-66).

**No coordination gate.** The concurrent book-1.7B work (fs-66) is merged; it did **not** introduce a `bookQualityOverride` flag — the override is the cast `ttsModelKey` written by `POST /cast/tier`. Do NOT add any competing book-quality flag; the only intent flag is `prosodyEnabled` (Task 11).

### Task 7: book-state `prosodyAnnotated` watermark

**Files:**
- Modify: `server/src/workspace/scan.ts` (server `BookStateJson`, near the existing `liveInstruct?` / `prosodyEnabled?` boolean field at lines 230–236); `server/src/routes/book-state.ts` (the `case 'state':` patch handler, lines 605–765).
- Modify: **`src/lib/types.ts`** — the **hand-maintained frontend `BookStateJson`** (~line 285; this is NOT generated from `api-types.ts`). Add `prosodyAnnotated?: boolean` so `st?.state.prosodyAnnotated` typechecks in Task 13's trigger (`BookStateResponse.state: BookStateJson`, `types.ts:375`). **Omitting this is a frontend TS error that fails `npm run typecheck`** (round-2 D-7c).
- Test: `server/src/routes/book-state.test.ts` (extend).

**Interfaces:**
- Produces: `BookStateJson.prosodyAnnotated?: boolean` (BOTH the server `scan.ts` type and the frontend `src/lib/types.ts` type) — true once both prosody passes complete for the book; the trigger fires only when absent/false. **Distinct from the `prosodyEnabled` intent flag (Task 11): `prosodyEnabled` = "should we annotate", `prosodyAnnotated` = "annotation finished".**

- [ ] **Step 1: Write the failing test** — `PUT /api/books/:bookId/state {patch:{prosodyAnnotated:true}}` persists the field; an absent/non-boolean patch leaves it unchanged.
- [ ] **Step 2: Run, verify fail** — `cd server && npm run test -- book-state` → FAIL.
- [ ] **Step 3: Implement** — add the optional field to **both** `BookStateJson` types (server `scan.ts` + frontend `src/lib/types.ts`; JSDoc, additive — do NOT bump `CURRENT_STATE_SCHEMA`, mirror the existing single-boolean field's note) + a boolean picker in the `case 'state':` spread (mirror the existing single-boolean ternary in that handler).
- [ ] **Step 4: Run, verify pass** — server `book-state` test + `npm run typecheck` (catches the frontend-type omission).
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
- Produces: `runProsodyPasses(bookId, { dispatch, signal?, onProgress? }): Promise<{ totalAnnotations: number; totalChapters: number; failed: number }>` — runs `api.detectEmotions` then `api.detectInstruct`, dispatching `applyDetectedEmotions`/`applyDetectedInstruct`, summing failures via `onChapterFailed`. **`signal` is OPTIONAL** (round-2 D-1a): Task 13's detached background job passes none. The returned `failed` count is load-bearing — Task 13 only writes the watermark when `failed === 0`.

- [ ] TDD: test that it calls both api passes in order and dispatches both apply actions; that a `chapter-failed` event increments `failed`; that it resolves (does NOT throw) on partial failure. Mock `api`. Commit `refactor(frontend): extract runProsodyPasses from DetectEmotionsButton`.

### Task 11: rename `liveInstruct` → `prosodyEnabled` (eager-default Phase-3 intent flag)

The fs-66-orphaned `liveInstruct` flag is renamed and repurposed as the Phase-3 intent flag. Semantics: **absent ⇒ ON** (eager default); only an explicit `false` opts out. Keep it nullable (`boolean | undefined`) so the toggle can store an explicit `false`/`true`; the Task-13 gate is simply `prosodyEnabled !== false`.

**Files:**
- Modify: `server/src/workspace/scan.ts` — rename `BookStateJson.liveInstruct?` → `prosodyEnabled?` (line 236) + rewrite its JSDoc (NO LONGER a synth-path flag — it is the Phase-3 annotation intent flag; absent ⇒ on, `false` = opted out).
- Modify: `server/src/routes/book-state.ts` — the `case 'state':` picker that reads `liveInstruct` (lines 706–708) → `prosodyEnabled` (keep the same boolean-typeof guard).
- Modify: `src/store/book-meta-slice.ts` — rename `liveInstruct` field (55, 61), the `setLiveInstruct`-payload type (72), hydration (94), `setLiveInstruct` (119–120), `selectLiveInstruct` (167–170) to `prosodyEnabled`/`setProsodyEnabled`/`selectProsodyEnabled`. **Preserve undefined:** hydration `s.prosodyEnabled[bookId] = state.prosodyEnabled` (drop `?? false`); the selector returns `s.bookMeta.prosodyEnabled[bookId]` with **NO `?? false`** (the gate distinguishes `false` from absent). Rewrite the stale JSDoc at 114–118 (it claims a non-existent "persistence-middleware watches this action" — there is no such middleware; the durable PUT is issued by the Task-12 toggle).
- Modify: `src/components/layout.tsx:790` — hydration `liveInstruct: res.state.liveInstruct ?? false` → `prosodyEnabled: res.state.prosodyEnabled` (preserve undefined).
- Modify: **`src/lib/types.ts`** — the hand-maintained frontend `BookStateJson` has its own `liveInstruct?: boolean` (~line 371, distinct from `api-types.ts`); rename it → `prosodyEnabled?: boolean` + update the adjacent comment (~line 429 names the `instructHash` render path — leave THAT one). Omitting this is a frontend TS error (round-2 D-7c sibling).
- Modify: `openapi.yaml` — rename the book-state `liveInstruct` property (line 3361) → `prosodyEnabled` + rewrite its description (absent ⇒ on). **Do NOT touch line 4910** (the Sentence `instruct` "Qwen 1.7B liveInstruct path" comment names the synth path, not this flag). Then regenerate: `npm run openapi:types` (updates `src/lib/api-types.ts`).
- Modify tests: `src/store/book-meta-slice.test.ts`, `server/src/routes/book-state.test.ts` (the liveInstruct cases ~2128–2168), and any `setLiveInstruct`/`selectLiveInstruct` references.

**Interfaces:**
- Produces: `bookMetaActions.setProsodyEnabled({ bookId, value: boolean })`; `selectProsodyEnabled(bookId): (s: RootState) => boolean | undefined`; `BookStateJson.prosodyEnabled?: boolean` (undefined when absent ⇒ treated as ON by the gate).
- **Do NOT** rename the unrelated `instructHash`/`renderedInstructHashes` "liveInstruct render" comments in `segments-io.ts`/`stale-chapters.ts`/`handoff/schemas.ts`/`book-state.ts:460`, the local `liveInstruct` prop in `script-review-diff.tsx`, or the `hasLiveInstructMember` comment in `sentence-instruct-control.tsx` — they name the synth path, not this flag.

- [ ] **Step 1: Enumerate sites** — `git grep -n "liveInstruct\|LiveInstruct" src server/src openapi.yaml` and cross-check against the Files list; set aside the synth-path comments listed above. (Note: the action/selector currently have **zero non-test consumers** — orphaned plumbing — so no caller-site surprises.)
- [ ] **Step 2: Write the failing test** — extend `book-meta-slice.test.ts`: `selectProsodyEnabled(bookId)` returns `undefined` for an unset book; `true`/`false` after `setProsodyEnabled`; hydrating `{ prosodyEnabled: undefined }` leaves it undefined (NOT coerced to false).
- [ ] **Step 3: Run, verify fail** — `npm test -- book-meta` → FAIL (action/selector not renamed yet).
- [ ] **Step 4: Implement** — perform the rename across the Files list; preserve undefined at the selector + both hydration sites (the one non-mechanical change); `npm run openapi:types`.
- [ ] **Step 5: Run, verify pass** — `npm test -- book-meta` + `cd server && npm run test -- book-state` + `npm run typecheck` → PASS.
- [ ] **Step 6: Commit** — `refactor: rename liveInstruct flag to eager-default prosodyEnabled (Phase-3 intent)`.

### Task 12: analysis-form "Expressive directions" toggle (checked by default)

**Files:**
- Modify: `src/views/analysing.tsx` (start-analysis surface, near the "Start analysis" button ~line 1172) — add the toggle.
- Test: `src/views/analysing-prosody-toggle.test.tsx`.

**Interfaces:**
- Consumes: `selectProsodyEnabled(bookId)` + `bookMetaActions.setProsodyEnabled` (Task 11).

Behaviour:
- **Checked state** = `stored !== false`, where `stored = useAppSelector(selectProsodyEnabled(bookId))`. So it is **checked by default** (eager) — unset (`undefined`) and `true` both render checked; only an explicit `false` renders unchecked.
- **Null `bookId` guard** (round-2 D-2b): `bookId` can be `null` on the analysing surface (`analysing.tsx:660`). `selectProsodyEnabled(null)` returns `undefined` (safe to read), but `setProsodyEnabled` needs a non-null `bookId` — **hide/disable the toggle when `bookId == null`**.
- **On change:** `dispatch(bookMetaActions.setProsodyEnabled({ bookId, value }))` AND `void api.putBookState(bookId, { slice: 'state', patch: { prosodyEnabled: value } })` for durability. Unchecking stores `false`; re-checking stores `true`. **Do NOT gate the analysis POST on it** — Phase 3 runs after analysis via the client-side Task-13 trigger; the server never reads this during analysis.
- Label "Expressive directions"; helper text "Generate per-line emotion + delivery directions for the higher-quality (1.7B) voice. Runs in the background after analysis."

- [ ] **Step 1: Write the failing test** — with no stored value → toggle renders **checked** (eager default); with stored `false` → **unchecked**; unchecking dispatches `setProsodyEnabled({value:false})` and issues the PUT with `false`; re-checking issues `true`.
- [ ] **Step 2: Run, verify fail** — `npm test -- analysing-prosody-toggle` → FAIL.
- [ ] **Step 3: Implement** the toggle per Behaviour above.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(frontend): expressive-directions toggle on the analysis form (on by default)`.

### Task 13: eager auto-trigger keyed on library status (background-safe, retry-safe, authoritative)

**Round-2 Critical:** a `stageKind === 'confirm'` trigger is a single-active-book signal (`ui.stage` is singular) and would never observe a book analysed in the **background** — violating the concurrent-multi-book invariant. So the trigger keys off **`library.books` status transitions** instead (the substrate the plan-83 fan-out at `layout.tsx:940-976` already uses), seeded on first mount to skip pre-existing books, and reads the gate authoritatively from disk.

**Files:**
- Modify: `src/components/layout.tsx` — add a NEW `useEffect` near the plan-83 background fan-out (`:940-976`). It is **NOT** modeled on the cleanup-tied voice-match effect (`:895-917`) — its launched jobs are deliberately **detached** (must survive a book-switch). Reads `library.books` (the same `library` already in scope for `bgBookIds`).
- Test: `src/store/prosody-autotrigger.test.tsx`.

**Interfaces:**
- Consumes: `runProsodyPasses` (Task 10); `api.getBookState`/`api.putBookState`; `library.books[].status`/`.bookId`. **No cast read, no `selectProsodyEnabled` read** — the gate (`prosodyEnabled`) and the watermark (`prosodyAnnotated`) are both read from the launch's authoritative `getBookState`, which kills the opt-out hydration race (round-2 #2).

```tsx
// A book is "analysis-complete" once it has sentences — cast_pending and later.
const isAnalysisComplete = (s: string) =>
  s !== 'not_analysed' && s !== 'analysing' && s !== 'unreadable' && s !== 'orphaned';

const prosodyConsidered = useRef<Set<string>>(new Set());
const prosodySeeded = useRef(false);
const completeIds = library.books.filter((b) => isAnalysisComplete(b.status)).map((b) => b.bookId);
const completeKey = completeIds.join('|');                         // stable dep digest
useEffect(() => {
  if (!prosodySeeded.current) {                                    // first run: existing library = pre-existing
    completeIds.forEach((id) => prosodyConsidered.current.add(id));
    prosodySeeded.current = true;
    return;
  }
  for (const id of completeIds) {
    if (prosodyConsidered.current.has(id)) continue;               // already handled this session
    prosodyConsidered.current.add(id);
    void (async () => {                                            // detached: survives a book-switch (H2)
      try {
        const st = await api.getBookState(id);
        if (!st || st.state.prosodyEnabled === false) return;      // authoritative opt-out (round-2 #2)
        if (st.state.prosodyAnnotated) return;                     // watermark → no-op
        const { failed } = await runProsodyPasses(id, { dispatch });
        if (failed === 0) api.putBookState(id, { slice: 'state', patch: { prosodyAnnotated: true } });
        else prosodyConsidered.current.delete(id);                 // partial → allow fill-only re-run (round-2 #6)
      } catch {
        prosodyConsidered.current.delete(id);                      // transient error → retry (round-1 H3)
      }
    })();
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [completeKey]);
```
- **Library-status keyed, not active stage** (round-2 Critical): fires for the active book AND background books the instant their status reaches analysis-complete. No dependence on `stageKind`/`bookId`.
- **Seed-on-mount** skips the pre-existing library (no backlog auto-spend) and makes a `Layout` remount self-healing — a re-seed re-marks any in-flight book as considered, so it can't double-fire (round-2 #5).
- **Authoritative disk gate** (round-2 #2): both `prosodyEnabled` and `prosodyAnnotated` come from the single `getBookState`, never the store selector — so the opt-out can't be lost to a hydration race.
- **Partial-aware watermark** (round-2 #6): writes `prosodyAnnotated:true` only when `failed === 0`; a partial run is left un-watermarked and removed from `considered` so the fill-only-empty re-run tops it up.
- **Detached + retry-safe** (round-1 H2/H3): the job is not tied to the effect's cleanup (survives book-switch); `try/catch` removes the book from `considered` on throw.

- [ ] **Step 1: Write the failing test** (drive the effect via a `library.books` rerender): a book that **appears as `cast_pending` after the seeded first render** fires `runProsodyPasses` once; a book already complete **on the first render** is seeded and never fires (no retro-annotation); a **background** book transitioning fires even though no active stage references it (the Critical regression); `getBookState` → `{prosodyEnabled:false}` → no `runProsodyPasses` (authoritative opt-out, even with the store selector `undefined`); `{prosodyAnnotated:true}` → no-op; **two books transitioning → each fires once, neither aborted**; a resolved `{failed:1}` → no `putBookState` and the book is re-eligible on a later transition; `{failed:0}` → `putBookState` writes the watermark; a **rejected** pass removes the book from `considered`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** per the shape above.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(frontend): eager prosody auto-trigger keyed on library status (background-safe)`.

### Task 13b: opt-out render-time hint (round-1 M5)

When a book with `prosodyEnabled === false` is rendered at 1.7B it gets only the four canned `emotionToInstruct` phrases, silently. Surface a one-line hint so this isn't invisible.

**Files:**
- Modify: the cast/generate surface (`src/views/cast.tsx`, near the bulk-pin / generate action) — when `selectProsodyEnabled(bookId) === false` AND any cast member has `ttsModelKey === 'qwen3-tts-1.7b'`, render a dismissible inline hint: "Expressive directions are off for this book — using basic emotion phrases." with a **[Turn on]** action that `dispatch(setProsodyEnabled({bookId, value:true}))` + PUTs, then offers the manual "Detect emotions" run.
- Test: `src/views/cast-prosody-hint.test.tsx`.

- [ ] TDD: hint renders only when `prosodyEnabled===false` AND a 1.7B cast member exists; absent otherwise; [Turn on] flips the flag + issues the PUT. Commit `feat(frontend): hint when expressive directions are off on a 1.7B book`.
- [ ] **Scope note:** if this risks PR3 size, split it to an immediate follow-up PR (`feat/frontend-prosody-offhint`) — do NOT silently drop it (the spec names it a required surfacing).

### Task 14: global prosody progress pill

**Files:**
- Create: `src/store/prosody-slice.ts` (`activeStream: { bookId, progress, label } | null`), registered in `src/store/index.ts` reducer map only. **The slice is TRANSIENT** — UI-only progress state, like `notifications`: add ONLY the reducer to the map; do NOT add it to `persistence-middleware` or `broadcast-middleware` (no persistence/cross-tab sync). Confirm by grepping `src/store/index.ts` for how `notifications` is wired and match that (reducer-only).
- Modify: `src/components/layout.tsx` (lines ~1209–1251, beside `analysisPill`) to render a `prosodyPill` from `s.prosody.activeStream`; `runProsodyPasses` updates it via `onProgress`.
- Test: `src/store/prosody-slice.test.ts` + `src/components/layout-prosody-pill.test.tsx`.

- [ ] TDD: slice set/clear; pill renders label + percent while active, absent when null. Commit `feat(frontend): global prosody-detection progress pill`.

### Task 15: PR3 e2e + verify + open

- [ ] e2e `e2e/analysis-prosody-toggle.spec.ts`: a book with the toggle left on (default) → analysis completes → at the confirm/cast stage the prosody pill runs → annotations land (assert a sentence gains an `instruct`). Add a second assertion: a book with the toggle unchecked pre-analysis does NOT run the pass.
- [ ] `npm run verify` (full battery incl. e2e). Rebase on latest `origin/main`. Push `feat/analysis-phase3-prosody`. PR title `feat: auto-generate per-line prosody annotations after analysis (Phase 3)`, body links the spec §Deliverable-1 + the gate-model section + `Closes #1129`.

---

## Self-review notes

- **Spec coverage:** §2A → PR1 Tasks 1–2 + PR3 Task 9 (detect handlers). §2B shared chunker → PR2 Task 4; script-review consumption → Task 5. §Deliverable-1 (gate model): flag rename → Task 11; analysis-form toggle (checked by default) → Task 12; eager library-status auto-trigger (background-safe, authoritative, retry-safe) → Task 13; opt-out render hint (M5) → Task 13b; watermark → Task 7; chunker reuse by annotation passes → Task 8; global-pill surfacing → Task 14; reusable pass → Task 10.
- **Owned-core rule** (the round-2 fix) is centralized in Task 4 and consumed by Tasks 5 + 8 — no `opKey` cross-chunk dedupe anywhere.
- **No 4th in-pipeline phase / no `PHASE_WEIGHTS` edits** (round-2 blast-radius avoided): Phase 3 surfaces via its own `prosody-slice` pill (Task 14), not `ANALYSIS_PHASES`.
- **`prosodyEnabled` is the single intent flag** (Tasks 11–13), eager (`!== false` ⇒ on). The synth-time gate is `is17b` alone (fs-66) — there is NO competing book-quality flag and NO cast read in the gate.
- **Round-1 review folded:** C1/M6 dissolved by eager-default (no cast-derived eligibility); H2 (detached job, book-switch-safe) + H3 (retry-safe) in Task 13; M5 hint in Task 13b.
- **Round-2 review folded:** Critical (active-stage trigger misses background books) → Task 13 re-keyed to `library.books` status transitions + seed-on-mount; #2 (opt-out hydration race) → authoritative-disk gate in Task 13; #6 (partial-watermark) → `failed===0` guard; #5 (remount double-fire) → seed-on-mount; D-1a (`signal` optional) → Task 10; D-7c (frontend `BookStateJson`) → Tasks 7 + 11 touch `src/lib/types.ts`; D-2b (null bookId) → Task 12.
- **Two distinct booleans, don't conflate:** `prosodyEnabled` (Task 11 — "should we annotate", eager) vs `prosodyAnnotated` (Task 7 — "annotation finished", watermark).
