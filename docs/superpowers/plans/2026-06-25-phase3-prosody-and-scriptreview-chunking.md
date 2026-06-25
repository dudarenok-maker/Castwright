# Phase 3 prosody annotation + script-review chunking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop script review from silently failing on normal-sized chapters, make it work on huge (Cyrillic) chapters via a sentence-chunker, and auto-generate per-line prosody annotations as a gated post-analysis pass.

**Architecture:** Three independent PRs. PR1 surfaces a dropped SSE event (client only). PR2 adds a server sentence-chunker (owned-core ownership rule) consumed by script-review. PR3 auto-triggers the existing annotation routes (through PR2's chunker) after analysis when a per-book `liveInstruct` flag is on, with a completion watermark.

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
- **PR3 coordination:** a concurrent session owns `docs/superpowers/specs/2026-06-25-book-level-higher-quality-tier-design.md` (the synth-time book 1.7B override). PR3 MUST reuse the shared `liveInstruct` flag and MUST NOT introduce a competing book-quality flag. Rebase + reconcile before PR3 lands.

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
  const body = events.map((e) => `data: ${e}\n\n`).join('');
  return new Response(new Blob([body]).stream(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
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

- [ ] `npm run verify` (frontend leg green). Rebase on `origin/main`. Push `fix/frontend-scriptreview-chapter-failed`. Open PR titled `fix(frontend): surface script-review chapter-failed instead of a silent empty modal`, body links the spec §2A + `Closes #<2A issue>`.

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
export function chapterChunkBudget(engine: 'gemini' | 'local'): number; // wraps stage1ChunkBudgetForEngine w/ resolveAnalyzerNumCtx()
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

- [ ] **Step 3: Implement** — greedy accumulation by serialized char length; cores are disjoint contiguous runs; context = `overlap` sentences each side (clamped); ownership helpers as specified. `chapterChunkBudget(engine)` = `stage1ChunkBudgetForEngine(resolveStage1ChunkCharBudget(engine), resolveAnalyzerNumCtx(), engine)`. (Keep it a pure function over the sentence array; no I/O.)

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

- [ ] `npm run verify` (server + server-slow legs). Rebase on `origin/main`. Push `feat/server-analyzer-chapter-chunker`. PR title `feat(server): chunk script review over large chapters (owned-core sentence chunker)`, body links spec §2B + shared-component section + `Closes #<2B issue>`.

---

## PR3 — Phase 3 prosody annotation (branch `feat/analysis-phase3-prosody`)

**COORDINATION GATE (do first):** rebase on latest `origin/main`; check whether the concurrent book-1.7B work has landed a quality flag. Reuse `liveInstruct`; do NOT add a competing flag. If their `bookQualityOverride` exists, the toggle here still SETS `liveInstruct` (annotation generation is gated on `liveInstruct`, independent of their synth-time override).

### Task 7: book-state `prosodyAnnotated` watermark

**Files:**
- Modify: `server/src/workspace/scan.ts` (`BookStateJson`, near `liveInstruct?` at lines 230–236); `server/src/routes/book-state.ts` (the `case 'state':` patch handler, lines 605–765).
- Test: `server/src/routes/book-state.test.ts` (extend).

**Interfaces:**
- Produces: `BookStateJson.prosodyAnnotated?: boolean` — true once both prosody passes complete for the book; the auto-trigger fires only when absent/false.

- [ ] **Step 1: Write the failing test** — `PUT /api/books/:bookId/state {patch:{prosodyAnnotated:true}}` persists the field; an absent/non-boolean patch leaves it unchanged.
- [ ] **Step 2: Run, verify fail** — `cd server && npm run test -- book-state` → FAIL.
- [ ] **Step 3: Implement** — add the optional field (JSDoc, additive — do NOT bump `CURRENT_STATE_SCHEMA`, mirror the `liveInstruct` note) + a boolean picker in the `case 'state':` spread (mirror the existing `liveInstruct` ternary).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `feat(server): prosodyAnnotated watermark on book state`.

### Task 8: annotation routes consume the chunker

**Files:**
- Modify: `server/src/routes/instruct-annotation.ts` (the per-chapter loop ~129) and `server/src/routes/annotate-emotion.ts` (its sibling loop).
- Test: `server/src/routes/instruct-annotation.test.ts`, `server/src/routes/annotate-emotion.test.ts` (extend).

**Interfaces:**
- Consumes: PR2's `chunkSentencesByBudget`/`chunkWithContext`/`chapterChunkBudget`; annotation ownership uses `coreIds.has(ann.sentenceId)` (no structural ops here — annotations are per-sentence).

- [ ] **Step 1: Write the failing test** — with a forced-low `num_ctx`, a large chapter is chunked; each sentence's annotation is emitted exactly once (owned-core), no truncation/`chapter-failed`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — wrap the existing `runStage3Chapter` / emotion call in a per-chunk loop building the inbox from `chunkWithContext(chunk)`, filtering returned annotations to `chunk.coreIds.has(ann.sentenceId)` before `send({kind:'annotation',...})`.
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

### Task 11: analysis-form "High-quality prosody (Qwen 1.7B)" toggle

**Files:**
- Modify: `src/views/analysing.tsx` (the start-analysis surface) — add the toggle; on change dispatch `bookMetaActions.setLiveInstruct({ bookId, value })` and PUT `{slice:'state',patch:{liveInstruct}}` (existing book-state PUT path); **await the PUT before the analysis POST fires** (spec ordering note).
- Test: `src/views/analysing-prosody-toggle.test.tsx` + one e2e `e2e/analysis-prosody-toggle.spec.ts`.

**Interfaces:**
- Consumes: `bookMetaActions.setLiveInstruct({ bookId, value })` (`book-meta-slice.ts:119`); `selectLiveInstruct(bookId)` (`:167`).

- [ ] TDD: toggling sets `bookMeta.liveInstruct[bookId]` and issues the PUT; default off. Commit `feat(frontend): high-quality prosody toggle on the analysis form`.

### Task 12: post-analysis auto-trigger + watermark

**Files:**
- Modify: `src/components/layout.tsx` (or a small effect host that observes `ui.stage` reaching `confirm`/`ready`) — when `selectLiveInstruct(bookId)` is true AND the book's `prosodyAnnotated` watermark is not set AND no prosody run is active → `runProsodyPasses(bookId, …)`; on success PUT `{patch:{prosodyAnnotated:true}}`.
- Test: `src/store/prosody-autotrigger.test.tsx`.

**Interfaces:**
- Consumes: `runProsodyPasses` (Task 10); `selectLiveInstruct` (Task 11); `prosodyAnnotated` from book state (Task 7, read via book-meta hydration or a fetch).

- [ ] TDD: fires exactly once when gate on + watermark incomplete; does NOT fire when off or watermark complete; a re-fire after partial fills only empties (assert `applyDetectedInstruct` fill-only-empty preserved). Commit `feat(frontend): auto-run prosody passes after analysis when enabled`.

### Task 13: global prosody progress pill

**Files:**
- Create: `src/store/prosody-slice.ts` (`activeStream: { bookId, progress, label } | null`), registered in `src/store/index.ts`.
- Modify: `src/components/layout.tsx` (lines ~1209–1251, beside `analysisPill`) to render a `prosodyPill` from `s.prosody.activeStream`; `runProsodyPasses` updates it via `onProgress`.
- Test: `src/store/prosody-slice.test.ts` + `src/components/layout-prosody-pill.test.tsx`.

- [ ] TDD: slice set/clear; pill renders label + percent while active, absent when null. Commit `feat(frontend): global prosody-detection progress pill`.

### Task 14: PR3 e2e + verify + open

- [ ] e2e `e2e/analysis-prosody-toggle.spec.ts`: toggle on → analysis completes → user reaches cast while the prosody pill runs → annotations land (assert a sentence gains an `instruct`).
- [ ] `npm run verify` (full battery incl. e2e). Rebase on `origin/main` + reconcile with the concurrent 1.7B branch. Push `feat/analysis-phase3-prosody`. PR title `feat: auto-generate per-line prosody annotations after analysis (Phase 3)`, body links the spec §Deliverable-1 + the coordination note + `Closes #<Phase3 issue>`.

---

## Self-review notes

- **Spec coverage:** §2A → PR1 Tasks 1–2 + PR3 Task 9 (detect handlers). §2B shared chunker → PR2 Task 4; script-review consumption → Task 5. §Deliverable-1: toggle → Task 11; separate post-analysis trigger → Task 12; watermark → Task 7; chunker reuse by annotation passes → Task 8; global-pill surfacing → Task 13; reusable pass → Task 10. Coordination note → PR3 gate.
- **Owned-core rule** (the round-2 fix) is centralized in Task 4 and consumed by Tasks 5 + 8 — no `opKey` cross-chunk dedupe anywhere.
- **No 4th in-pipeline phase / no `PHASE_WEIGHTS` edits** (round-2 blast-radius avoided): Phase 3 surfaces via its own `prosody-slice` pill (Task 13), not `ANALYSIS_PHASES`.
- **liveInstruct is the single shared flag** (Tasks 11–12) — no competing book-quality flag; the concurrent synth-time override reads `liveInstruct || bookQualityOverride`.
