# Attribution per-chapter sentence progress + honest ETA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the useless "still waiting on the model" rows during Stage-1 attribution with a live, trustworthy "Attributed ~N of ~M sentences" headline, keep the chars/s speed pulse, and harden the flaky per-chapter ETA.

**Architecture:** A new pure-function module (`server/src/analyzer/sentence-progress.ts`) holds the count/estimate math. The Stage-2 chunker gains an `onSectionDone` callback so the route can accumulate exact per-section sentence counts (the streamed buffer resets each section, so a single chapter-wide marker count is wrong). The route's per-chapter `InFlight` slot grows sentence/section fields that ride the existing `live` SSE payload; the frontend `LiveChapterRow` renders the headline + bar. Wave B adds sentence-fraction ETA projection clamped to a per-chapter band, and re-diagnoses the reload-elapsed bug.

**Tech Stack:** TypeScript, Node/Express (server), Vitest (server + frontend unit, colocated `*.test.ts(x)`), React 18 (frontend), Playwright (e2e), SSE for live progress.

**Spec:** `docs/superpowers/specs/2026-06-17-attribution-sentence-progress-design.md`
**Branch (already cut):** `feat/analysing-attribution-progress`
**Regression plan to update:** `docs/features/216-analysing-local-analyzer-honesty.md` (no new plan doc).

## Global Constraints

- **TDD always:** failing test first, watch it fail, minimal impl, watch it pass, commit. One logical change per commit.
- **Commit convention:** `<type>(<scope>): <subject>` — e.g. `feat(server): …`, `feat(frontend): …`, `test(server): …`, `docs(docs): …`. Enforced by the commit-msg hook.
- **Pure-fn style:** new math goes in `server/src/analyzer/sentence-progress.ts` as exported pure functions (no I/O, no model calls), mirroring `projectChapterEstMsFromOutput` / `refineCastChapterEstMs` in `analysis.ts`. Colocated test `sentence-progress.test.ts`.
- **OpenAPI / types:** `AnalysisLiveChapter` lives in `src/lib/api.ts` and already carries optional `sectionsDone?`/`sectionsTotal?`. Extend it there; do not hand-write a parallel type.
- **No hex literals in component code** — use existing Tailwind/CSS-var tokens (`text-ink/60`, `bg-ink/10`, etc.).
- **Server tests:** `cd server && npm run test` (or the slow tier for analyzer/route files: `npm run test:server-slow`). The route test file `analysis.test.ts` is in the slow tier.
- **Frontend tests:** `npm run test`. **E2E:** `npm run test:e2e`.
- **Marker token is `"characterId":`** (with colon, optional whitespace) — counted only within the CURRENT section's buffer; completed sections contribute exact `sentences.length`.

---

## Wave A — Sentence-count headline + section accumulation + chars/s retention

Self-contained visible win. Ships without the on-box reload repro. The existing (flaky) estimate row is untouched here — Wave B fixes it. The sentence count is the trustworthy headline regardless.

### Task A1: Pure counters — heuristic denominator + streamed numerator

**Files:**
- Create: `server/src/analyzer/sentence-progress.ts`
- Test: `server/src/analyzer/sentence-progress.test.ts`

**Interfaces:**
- Produces: `countSentencesHeuristic(body: string): number`, `countStreamedSentences(buffer: string): number`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/analyzer/sentence-progress.test.ts
import { describe, it, expect } from 'vitest';
import { countSentencesHeuristic, countStreamedSentences } from './sentence-progress.js';

describe('countSentencesHeuristic', () => {
  it('counts sentence-boundary splits', () => {
    expect(countSentencesHeuristic('He ran. She hid! Did he? Yes.')).toBe(4);
  });
  it('returns 0 for empty / whitespace', () => {
    expect(countSentencesHeuristic('')).toBe(0);
    expect(countSentencesHeuristic('   \n  ')).toBe(0);
  });
  it('counts a single unpunctuated line as 1', () => {
    expect(countSentencesHeuristic('a quiet fragment')).toBe(1);
  });
});

describe('countStreamedSentences', () => {
  it('counts one per "characterId": key token', () => {
    const buf = '{"sentences":[{"id":1,"characterId":"narrator","text":"Hi."},{"id":2,"characterId":"mara","text":"Go."}';
    expect(countStreamedSentences(buf)).toBe(2);
  });
  it('tolerates whitespace before the colon and a mid-token tail', () => {
    const buf = '{"sentences":[{"id":1,"characterId" : "narrator","text":"Hi."},{"id":2,"characterId';
    expect(countStreamedSentences(buf)).toBe(1); // the half-written 2nd has no colon yet
  });
  it('returns 0 for empty', () => {
    expect(countStreamedSentences('')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/sentence-progress.test.ts`
Expected: FAIL — `Cannot find module './sentence-progress.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/analyzer/sentence-progress.ts
/* Pure progress math for Stage-2 (attribution) per-chapter live progress.
   No I/O, no model calls — mirrors the projectChapterEstMsFromOutput family in
   analysis.ts so each piece is unit-testable in isolation. See
   docs/superpowers/specs/2026-06-17-attribution-sentence-progress-design.md. */

/** Heuristic per-chapter sentence total (the denominator seed). Splits on
    sentence-ending punctuation, mirroring stage2-chunk's sentence regex.
    Approximate by nature — the model may merge/split — so callers show it
    with a leading `~`. */
export function countSentencesHeuristic(body: string): number {
  const trimmed = body.trim();
  if (!trimmed) return 0;
  return trimmed.split(/(?<=[.!?]["')\]]?)\s+/).filter(Boolean).length;
}

/** Count attributed sentences in ONE section's streamed (possibly partial)
    JSON buffer, via the `"characterId":` key token (exactly one per sentence
    object). The buffer resets per section (the engine re-inits its buffer each
    section call), so this is the IN-FLIGHT section count only — completed
    sections are accounted exactly elsewhere. Counting the full key token (with
    colon) makes a stray substring in prose vanishingly unlikely. */
export function countStreamedSentences(buffer: string): number {
  if (!buffer) return 0;
  return (buffer.match(/"characterId"\s*:/g) ?? []).length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/analyzer/sentence-progress.test.ts`
Expected: PASS (6 assertions).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/sentence-progress.ts server/src/analyzer/sentence-progress.test.ts
git commit -m "feat(server): pure sentence counters for attribution progress"
```

---

### Task A2: Pure denominator self-calibration

**Files:**
- Modify: `server/src/analyzer/sentence-progress.ts`
- Test: `server/src/analyzer/sentence-progress.test.ts`

**Interfaces:**
- Produces: `refineSentencesTotal(args: { committedSentences: number; committedChars: number; totalChars: number; heuristicTotal: number }): number`

- [ ] **Step 1: Write the failing test (append)**

```ts
import { refineSentencesTotal } from './sentence-progress.js';

describe('refineSentencesTotal', () => {
  it('returns the heuristic when no section has completed', () => {
    expect(
      refineSentencesTotal({ committedSentences: 0, committedChars: 0, totalChars: 9000, heuristicTotal: 300 }),
    ).toBe(300);
  });
  it('projects from observed sentences-per-char once a section is done', () => {
    // section 1: 100 sentences over 1000 chars → 0.1/char; 9000 total chars.
    // projected = 100 + 0.1 * (9000 - 1000) = 900.
    expect(
      refineSentencesTotal({ committedSentences: 100, committedChars: 1000, totalChars: 9000, heuristicTotal: 300 }),
    ).toBe(900);
  });
  it('never returns below the committed count', () => {
    expect(
      refineSentencesTotal({ committedSentences: 50, committedChars: 9000, totalChars: 9000, heuristicTotal: 10 }),
    ).toBe(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/sentence-progress.test.ts`
Expected: FAIL — `refineSentencesTotal is not a function`.

- [ ] **Step 3: Write minimal implementation (append to sentence-progress.ts)**

```ts
/** Self-calibrate the denominator once ≥1 section is committed: the observed
    sentences-per-char from completed sections, applied to the remaining chars.
    Falls back to the static heuristic before any section completes (graceful
    degradation — the headline count still works, it is just less
    self-correcting). Never returns below the already-committed count. */
export function refineSentencesTotal(args: {
  committedSentences: number;
  committedChars: number;
  totalChars: number;
  heuristicTotal: number;
}): number {
  const { committedSentences, committedChars, totalChars, heuristicTotal } = args;
  if (committedSentences <= 0 || committedChars <= 0) return heuristicTotal;
  const rate = committedSentences / committedChars;
  const remainingChars = Math.max(0, totalChars - committedChars);
  const projected = Math.round(committedSentences + rate * remainingChars);
  return Math.max(projected, committedSentences);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/analyzer/sentence-progress.test.ts`
Expected: PASS (9 assertions total).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/sentence-progress.ts server/src/analyzer/sentence-progress.test.ts
git commit -m "feat(server): self-calibrating denominator for sentence progress"
```

---

### Task A3: `onSectionDone` callback in the Stage-2 chunker

**Files:**
- Modify: `server/src/analyzer/stage2-chunk.ts:157-179` (add to `Stage2ChunkRunOptions`), `:237-248` (`runChunks`), `:263-277` (single-call path)
- Modify: `server/src/routes/analysis.ts:1478-1519` (`attributeChapterStage2` — forward the callback)
- Test: `server/src/analyzer/stage2-chunk.test.ts`

**Interfaces:**
- Produces: `Stage2ChunkRunOptions.onSectionDone?: (index: number, sentenceCount: number) => void`, fired AFTER each section's sentences are parsed (both the multi-chunk and the single-call paths). `attributeChapterStage2` opts gain a matching `onSectionDone?`.
- Consumes: the existing `runStage2ChapterChunked` from Task A4's route wiring.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/analyzer/stage2-chunk.test.ts  (add a describe block)
import { describe, it, expect } from 'vitest';
import { runStage2ChapterChunked } from './stage2-chunk.js';

describe('onSectionDone', () => {
  it('fires once per section with the section sentence count (multi-chunk)', async () => {
    const body = 'A'.repeat(50) + '\n\n' + 'B'.repeat(50); // 2 paragraphs
    const calls: Array<[number, number]> = [];
    await runStage2ChapterChunked({
      body,
      charBudget: 60, // forces a 2-section split
      coverageRetries: 0,
      callForBody: async (sub) => ({
        // 2 sentences for the first span, 3 for the second — distinguishable
        sentences: (sub.includes('A') ? [1, 2] : [1, 2, 3]).map((id) => ({
          id,
          chapterId: 1,
          characterId: 'narrator',
          text: 'x',
        })),
      }),
      onSectionDone: (i, n) => calls.push([i, n]),
    });
    expect(calls).toEqual([[0, 2], [1, 3]]);
  });

  it('fires once with index 0 on the single-call path', async () => {
    const calls: Array<[number, number]> = [];
    await runStage2ChapterChunked({
      body: 'short body',
      charBudget: 9000,
      coverageRetries: 0,
      callForBody: async () => ({
        sentences: [1, 2].map((id) => ({ id, chapterId: 1, characterId: 'narrator', text: 'x' })),
      }),
      onSectionDone: (i, n) => calls.push([i, n]),
    });
    expect(calls).toEqual([[0, 2]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/stage2-chunk.test.ts -t onSectionDone`
Expected: FAIL — `calls` is `[]` (callback never invoked).

- [ ] **Step 3: Write minimal implementation**

In `server/src/analyzer/stage2-chunk.ts`, add to `Stage2ChunkRunOptions` (after the existing `onChunk` at `:178`):

```ts
  /** Fired AFTER a section's sentences are parsed, with the section index and
      its exact sentence count. The route accumulates these into the committed
      (exact) numerator; the streamed marker count only ever covers the
      in-flight section. */
  onSectionDone?: (index: number, sentenceCount: number) => void;
```

In `runChunks` (`:240-244`), capture each section's result and fire the callback:

```ts
    for (let i = 0; i < chunks.length; i += 1) {
      opts.onChunk?.({ index: i, total: chunks.length, chars: chunks[i].length });
      const sectionSentences = await attributeSpan(chunks[i], 0, preceding);
      opts.onSectionDone?.(i, sectionSentences.length);
      all.push(...sectionSentences);
      preceding = tailParagraphs(chunks[i], contextParagraphs);
    }
```

In the single-call success path (`:264-271`), after the guard returns:

```ts
      const { result, coverage } = await runStage2WithCoverageGuard({
        body: opts.body,
        maxRetries: opts.coverageRetries,
        call: () => opts.callForBody(opts.body, null),
        thresholds: opts.coverageThresholds,
        onRetry: opts.onRetry,
      });
      opts.onSectionDone?.(0, result.sentences.length);
      return { sentences: result.sentences, coverage, chunkCount: 1 };
```

(The single-call truncation fallback calls `runChunks(forced)`, which already fires `onSectionDone` per forced section — no extra wiring there.)

Then forward it through `attributeChapterStage2` in `server/src/routes/analysis.ts`. Add to the opts type (`:1491`):

```ts
  onChunk?: (info: { index: number; total: number; chars: number }) => void;
  onSectionDone?: (index: number, sentenceCount: number) => void;
```

and pass it into the chunker call (`:1518`):

```ts
    onChunk: opts.onChunk,
    onSectionDone: opts.onSectionDone,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/analyzer/stage2-chunk.test.ts -t onSectionDone`
Expected: PASS. Then `npx vitest run src/analyzer/stage2-chunk.test.ts` to confirm no regression in the existing chunker tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/stage2-chunk.ts server/src/analyzer/stage2-chunk.test.ts server/src/routes/analysis.ts
git commit -m "feat(server): onSectionDone callback for stage-2 section accumulation"
```

---

### Task A4: Route wiring — section-accumulated numerator + live payload fields

**Files:**
- Modify: `server/src/routes/analysis.ts:3332-3341` (`InFlight`), `:3344-3369` (`sendLiveTick`), `:3404-3522` (`runChapter` — accumulate + threshold), `:3548-3555` (the `attributeChapterStage2` call — pass section callbacks)
- Modify: `src/lib/api.ts:126-137` (`AnalysisLiveChapter` — new optional fields)
- Test: `server/src/routes/analysis.test.ts`

**Interfaces:**
- Consumes: `countStreamedSentences`, `countSentencesHeuristic`, `refineSentencesTotal` (Task A1/A2); `onSectionDone` (Task A3).
- Produces: live payload `chapters[]` entries gain `sentencesDone`, `sentencesTotal`, `inSentenceMode`, `sectionsDone`, `sectionsTotal`. Server constant `SENTENCE_MODE_MIN_MARKERS = 5`.

- [ ] **Step 1: Write the failing test**

Add a focused test that drives the accumulation math the route will use. To keep it unit-level (the full route is integration-heavy), extract the per-tick numerator into a tiny pure helper and test THAT, then wire it in. Add to `server/src/analyzer/sentence-progress.test.ts`:

```ts
import { sentenceProgressForTick } from './sentence-progress.js';

describe('sentenceProgressForTick (anti-snap-back across a section boundary)', () => {
  const base = { totalChars: 2000, heuristicTotal: 200 };
  it('mid section 1: committed 0 + in-flight markers', () => {
    const r = sentenceProgressForTick({ ...base, committedSentences: 0, committedChars: 0, inflightSentences: 40 });
    expect(r.sentencesDone).toBe(40);
  });
  it('section 1 done (100 over 1000 chars), section 2 just started: count does NOT drop', () => {
    const afterS1 = sentenceProgressForTick({ ...base, committedSentences: 100, committedChars: 1000, inflightSentences: 0 });
    const earlyS2 = sentenceProgressForTick({ ...base, committedSentences: 100, committedChars: 1000, inflightSentences: 3 });
    expect(afterS1.sentencesDone).toBe(100);
    expect(earlyS2.sentencesDone).toBe(103); // committed + new in-flight, never < 100
    expect(earlyS2.sentencesDone).toBeGreaterThanOrEqual(afterS1.sentencesDone);
  });
  it('displayed total never falls below sentencesDone', () => {
    const r = sentenceProgressForTick({ totalChars: 1000, heuristicTotal: 5, committedSentences: 50, committedChars: 1000, inflightSentences: 0 });
    expect(r.sentencesTotal).toBeGreaterThanOrEqual(r.sentencesDone);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/sentence-progress.test.ts -t sentenceProgressForTick`
Expected: FAIL — `sentenceProgressForTick is not a function`.

- [ ] **Step 3: Write minimal implementation (append to sentence-progress.ts)**

```ts
/** Combine committed (exact, per completed section) + in-flight (marker count
    for the current section) into the displayed numerator, and pair it with a
    self-calibrated denominator that never sits below the numerator. */
export function sentenceProgressForTick(args: {
  committedSentences: number;
  committedChars: number;
  inflightSentences: number;
  totalChars: number;
  heuristicTotal: number;
}): { sentencesDone: number; sentencesTotal: number } {
  const sentencesDone = args.committedSentences + args.inflightSentences;
  const refined = refineSentencesTotal({
    committedSentences: args.committedSentences,
    committedChars: args.committedChars,
    totalChars: args.totalChars,
    heuristicTotal: args.heuristicTotal,
  });
  return { sentencesDone, sentencesTotal: Math.max(refined, sentencesDone) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/analyzer/sentence-progress.test.ts -t sentenceProgressForTick`
Expected: PASS.

- [ ] **Step 5: Extend the frontend type**

In `src/lib/api.ts`, extend `AnalysisLiveChapter` (after `sectionsTotal?` at `:136`):

```ts
  /** Sentences attributed so far (committed exact + in-flight marker count).
      Absent until the chapter enters sentence mode. */
  sentencesDone?: number;
  /** Self-calibrated sentence total (shown with a leading `~`). */
  sentencesTotal?: number;
  /** Once true, the row shows the sentence headline; one-way per chapter
      (set server-side so a reload can't revert it). */
  inSentenceMode?: boolean;
  sectionsDone?: number;
```

(Confirm `sectionsDone?` isn't already declared just above `sectionsTotal?` — if it is, leave it; do not duplicate.)

- [ ] **Step 6: Wire the route**

In `server/src/routes/analysis.ts`:

(a) Add the import near the other analyzer imports (`:37-41`):

```ts
import {
  countSentencesHeuristic,
  countStreamedSentences,
  sentenceProgressForTick,
} from '../analyzer/sentence-progress.js';
```

(b) Add a constant near the other Stage-2 constants (top of file, by `DEFAULT_STAGE2_OUTPUT_RATIO`):

```ts
/* Sentence-mode display threshold: show the sentence headline once at least
   one section has completed OR this many in-flight markers have streamed.
   One-way per chapter (hysteresis) — never revert, so the row can't flip-flop
   between byte mode and sentence mode. */
const SENTENCE_MODE_MIN_MARKERS = 5;
```

(c) Extend `InFlight` (`:3332-3341`):

```ts
    interface InFlight {
      chapterIndex: number;
      chapterTitle: string;
      chapterEstMs: number;
      startedAt: number;
      elapsedMs: number;
      receivedBytes: number;
      /* Sentence progress (section-accumulated). committedChars/Sentences cover
         ONLY completed sections (kept in lockstep so the rate is never diluted);
         currentSectionChars is the in-flight section's size, stashed at section
         start and folded into committedChars when that section completes. */
      heuristicTotal: number;
      committedSentences: number;
      committedChars: number;
      currentSectionChars: number;
      inflightSentences: number;
      sectionsDone: number;
      sectionsTotal: number;
      inSentenceMode: boolean;
    }
```

(d) In `sendLiveTick` (`:3360-3365`), add the new fields to each chapter entry:

```ts
                chapters: running.map((r) => {
                  const prog = sentenceProgressForTick({
                    committedSentences: r.committedSentences,
                    committedChars: r.committedChars,
                    inflightSentences: r.inflightSentences,
                    totalChars: recordRef.chapterHints[r.chapterIndex].body.length,
                    heuristicTotal: r.heuristicTotal,
                  });
                  return {
                    chapterIndex: r.chapterIndex + 1,
                    chapterTitle: r.chapterTitle,
                    elapsedMs: r.elapsedMs,
                    estMs: r.chapterEstMs,
                    sectionsDone: r.sectionsDone,
                    sectionsTotal: r.sectionsTotal,
                    ...(r.inSentenceMode
                      ? { sentencesDone: prog.sentencesDone, sentencesTotal: prog.sentencesTotal, inSentenceMode: true }
                      : {}),
                  };
                }),
```

(e) In `runChapter`, seed the new slot fields (`:3408-3415`):

```ts
      inFlight.set(i, {
        chapterIndex: i,
        chapterTitle: ch.title,
        chapterEstMs,
        startedAt,
        elapsedMs: 0,
        receivedBytes: 0,
        heuristicTotal: countSentencesHeuristic(ch.body),
        committedSentences: 0,
        committedChars: 0,
        currentSectionChars: 0,
        inflightSentences: 0,
        sectionsDone: 0,
        sectionsTotal: 1,
        inSentenceMode: false,
      });
```

(f) In the streaming `onChunk` (`:3490-3495`), update the in-flight marker count and the hysteresis flag:

```ts
        onChunk: (info) => {
          const liveSlot = inFlight.get(i);
          if (liveSlot) {
            liveSlot.receivedBytes = info.receivedBytes;
            liveSlot.inflightSentences = countStreamedSentences(info.receivedText);
            if (!liveSlot.inSentenceMode && liveSlot.inflightSentences >= SENTENCE_MODE_MIN_MARKERS) {
              liveSlot.inSentenceMode = true;
            }
          }
          // …existing heartbeat/ETA code unchanged below…
```

(g) Pass the section callbacks into the `attributeChapterStage2` call (`:3548-3555`):

```ts
      } = await attributeChapterStage2({
        analyzer: phase1Analyzer,
        manuscriptId,
        title: recordRef.title,
        stage1: phase1Stage1,
        chapter: ch,
        stageCall: stage2Call,
        engine: phase1Selection.engine,
        // Section START: record this section's char count and total. Do NOT add
        // it to committedChars yet — committedChars must stay in lockstep with
        // committedSentences (completed sections only), or the rate dilutes and
        // the denominator collapses mid-section (adversarial-review fix #1).
        onChunk: (sec) => {
          const slot = inFlight.get(i);
          if (slot) {
            slot.sectionsTotal = sec.total;
            slot.currentSectionChars = sec.chars;
            slot.inflightSentences = 0; // fresh section → buffer reset on the engine side
          }
        },
        // Section DONE: commit BOTH chars and sentences together, so the
        // observed sentences-per-char rate is always measured over the same
        // completed sections.
        onSectionDone: (_index, sentenceCount) => {
          const slot = inFlight.get(i);
          if (!slot) return;
          slot.committedSentences += sentenceCount;
          slot.committedChars = Math.min(ch.body.length, slot.committedChars + slot.currentSectionChars);
          slot.sectionsDone += 1;
          slot.inflightSentences = 0;
          slot.inSentenceMode = true; // ≥1 section done always qualifies
          sendLiveTick();
        },
        onCoverageRetry: (attempt, verdict) =>
          // …existing…
```

Note: the single-call path (a chapter ≤ budget) never fires the section-start
`onChunk` (the chunker only calls it on the multi-chunk path), so `currentSectionChars`
stays 0 and `committedChars` stays 0 for that chapter — `refineSentencesTotal`
then returns the heuristic unchanged. That's correct: a single-section chapter
is short/fast and the final count is authoritative on completion. Within-chunk
adaptive re-splits (truncation recovery) can momentarily reset `inflightSentences`;
the non-decreasing guarantee holds across *committed section* boundaries, which is
what the test and e2e assert — note this edge in a code comment.

- [ ] **Step 7: Coverage via pure fns + e2e (NO route-integration harness)**

`analysis.test.ts` has **no** reusable end-to-end Phase-1 fake-analyzer + SSE-capture harness (confirmed: there's an explicit blocker comment deferring it, and the file tests this kind of logic via *pure* exported helpers like `castInFlightEntryToLiveChapter` at `analysis.test.ts:1809`). Do **not** build a route harness here. Anti-snap-back is already locked by the pure `sentenceProgressForTick` test in Step 1 (the section-boundary case asserts `earlyS2.sentencesDone >= afterS1.sentencesDone`), and the real route seam is covered by the e2e in Task A6. If you want one more server-side guard, add a tiny pure unit test asserting that committing a section then starting the next never lowers `sentenceProgressForTick(...).sentencesDone` — but no `phaseId: 1` end-to-end run.

- [ ] **Step 8: Run tests**

Run: `cd server && npx vitest run src/analyzer/sentence-progress.test.ts`
Expected: PASS. (No `analysis.test.ts` change in this task — the route wiring is type-checked by the build and exercised by the e2e.)

- [ ] **Step 9: Commit**

```bash
git add server/src/routes/analysis.ts server/src/analyzer/sentence-progress.ts server/src/analyzer/sentence-progress.test.ts src/lib/api.ts
git commit -m "feat(server): section-accumulated sentence progress in stage-2 live payload"
```

---

### Task A5: Frontend — sentence headline + bar; keep chars/s

**Files:**
- Modify: `src/components/analysing/phase-card.tsx:42-95` (`LiveChapterRow`)
- Test: `src/components/analysing/phase-card.test.tsx`

**Interfaces:**
- Consumes: `AnalysisLiveChapter.sentencesDone/sentencesTotal/inSentenceMode` (Task A4).

- [ ] **Step 1: Write the failing test**

**CRITICAL — Provider required.** `PhaseCard` calls `useAppSelector` unconditionally (`phase-card.tsx:401`), and `PhaseModelChip`/`PhaseModelSwap` render for `phaseId: 1`, so a bare `render(<PhaseCard/>)` throws "could not find react-redux context." The file **already exists** with the correct pattern: a `mountStore()` (account + cast slices) + `<Provider>` wrapper and a `renderPhase(phase)` helper. Reuse that infrastructure — add a `renderCard(overrides)` helper alongside it. Also note `AnalysisPhase` requires a `duration` field (`src/lib/types.ts:691` — `{ id, label, detail, duration }`).

Extend `src/components/analysing/phase-card.test.tsx`:

```tsx
// At top of file — these imports already exist in the file; add what's missing:
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PhaseCard } from './phase-card';
import type { AnalysisLiveChapter } from '../../lib/api';
import type { AnalysisPhase } from '../../lib/types';
// Reuse the file's existing accountSlice/castSlice imports + mountStore().

const phase1: AnalysisPhase = {
  id: 1,
  label: 'Parsing and attribution',
  detail: 'Splitting chapters into sentences and labelling each speaker.',
  duration: 1000,
};

function liveChapter(over: Partial<AnalysisLiveChapter> = {}): AnalysisLiveChapter {
  return { chapterIndex: 1, chapterTitle: 'Chapter 1', elapsedMs: 5000, estMs: 60000, ...over };
}

// Wraps PhaseCard in a real store so useAppSelector resolves. mountStore() is
// the helper already defined in this file (account + cast reducers).
function renderCard(props: Partial<React.ComponentProps<typeof PhaseCard>>) {
  return render(
    <Provider store={mountStore()}>
      <PhaseCard
        phase={phase1}
        activePhaseId={1}
        phaseProgress={0.4}
        phaseLogs={['x']}
        live={null}
        isLocalAnalyzer
        analysisStarted
        conn="streaming"
        bookId={null}
        droppedQuotesRefreshKey={0}
        {...props}
      />
    </Provider>,
  );
}

describe('LiveChapterRow sentence headline', () => {
  it('shows "Attributed ~N of ~M sentences" in sentence mode', () => {
    renderCard({
      live: { totalChapters: 9, chapters: [liveChapter({ sentencesDone: 247, sentencesTotal: 900, inSentenceMode: true })] },
    });
    expect(screen.getByText(/Attributed ~247 of ~900 sentences/)).toBeInTheDocument();
  });

  it('omits the sentence headline before sentence mode', () => {
    renderCard({ live: { totalChapters: 9, chapters: [liveChapter()] } });
    expect(screen.queryByText(/Attributed/)).not.toBeInTheDocument();
  });
});
```

Use this same `renderCard(...)` helper for every subsequent frontend test in Tasks A5 and B3 — never call bare `render(<PhaseCard/>)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/analysing/phase-card.test.tsx -t "sentence headline"`
Expected: FAIL — text not found (headline not rendered yet).

- [ ] **Step 3: Write minimal implementation**

In `LiveChapterRow` (`phase-card.tsx`), after the existing time/section block (inside the outer `<div className="flex flex-col gap-0.5">`, after the section sub-bar at `:92`), add the sentence headline + bar:

```tsx
      {chapter.inSentenceMode && chapter.sentencesTotal ? (
        <>
          <div className="inline-flex items-center gap-2 text-[11px] font-mono tabular-nums text-ink/70">
            <span className="font-semibold">
              Attributed ~{chapter.sentencesDone ?? 0} of ~{chapter.sentencesTotal} sentences
            </span>
          </div>
          <div className="h-0.5 w-48 rounded-full bg-ink/10 overflow-hidden">
            <div
              className="h-full rounded-full bg-magenta/40"
              style={{
                width: `${Math.min(100, ((chapter.sentencesDone ?? 0) / chapter.sentencesTotal) * 100)}%`,
              }}
            />
          </div>
        </>
      ) : null}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/analysing/phase-card.test.tsx`
Expected: PASS.

- [ ] **Step 5: Add a chars/s regression guard**

Add a test asserting `HeartbeatRow`'s chars/s still renders when a heartbeat is present (so the sentence work can't silently drop the speed pulse):

```tsx
it('keeps the chars/s speed pulse in the heartbeat row', () => {
  renderCard({
    live: { totalChapters: 9, chapters: [liveChapter({ sentencesDone: 10, sentencesTotal: 900, inSentenceMode: true })] },
    heartbeat: { hb: { phaseId: 1, receivedBytes: 2048, charsPerSec: 145, elapsedMs: 14000, sinceLastChunkMs: 0, chapterIndex: 1 }, receivedAt: Date.now() },
  });
  expect(screen.getByText(/145 chars\/s/)).toBeInTheDocument();
});
```

Run: `npx vitest run src/components/analysing/phase-card.test.tsx` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/analysing/phase-card.tsx src/components/analysing/phase-card.test.tsx
git commit -m "feat(frontend): sentence-count headline + bar in attribution live row"
```

---

### Task A6: E2E — mock SSE emits sentence fields; analysing spec

**Files:**
- Modify: `src/mocks/canned-data.ts` (the Phase-1 live-progress simulation — search for where it emits `kind: 'phase'` with a `live` payload and `phaseId: 1`)
- Create/Modify: `e2e/analysing-progress.spec.ts` (or extend the existing analysing spec under `e2e/`)
- Test: the spec itself

- [ ] **Step 1: Add the new fields to the mock live payload**

In `src/mocks/canned-data.ts`, find the Phase-1 simulated `live.chapters[]` emission and add, for an in-flight chapter, a two-section progression that crosses a boundary without snapping back, e.g. emit successive ticks with:

```ts
// tick 1 (section 1, in-flight): committed 0, marker 6 → in sentence mode
{ chapterIndex: 1, chapterTitle: 'Chapter 1', elapsedMs: 4000, estMs: 60000,
  sectionsDone: 0, sectionsTotal: 2, sentencesDone: 6, sentencesTotal: 120, inSentenceMode: true },
// tick 2 (section 1 done): committed 60
{ /* … */ sectionsDone: 1, sentencesDone: 60, sentencesTotal: 120, inSentenceMode: true },
// tick 3 (section 2, in-flight): committed 60 + marker 5 = 65 (never < 60)
{ /* … */ sectionsDone: 1, sentencesDone: 65, sentencesTotal: 120, inSentenceMode: true },
```

- [ ] **Step 2: Write the failing spec**

```ts
// e2e/analysing-progress.spec.ts
import { test, expect } from '@playwright/test';

test('attribution shows a non-snapping sentence count + chars/s', async ({ page }) => {
  await page.goto('/'); // drive the app into the analysing stage per the existing e2e helpers
  // … reuse the project's helper to start a mock analysis and reach Phase 1 …
  const headline = page.getByText(/Attributed ~\d+ of ~\d+ sentences/);
  await expect(headline).toBeVisible();

  // Capture the count across ticks; assert it never decreases.
  const reads: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const txt = await headline.textContent();
    const n = Number(/~(\d+) of/.exec(txt ?? '')?.[1] ?? '0');
    reads.push(n);
    await page.waitForTimeout(600);
  }
  for (let i = 1; i < reads.length; i += 1) expect(reads[i]).toBeGreaterThanOrEqual(reads[i - 1]);

  // chars/s pulse still present.
  await expect(page.getByText(/chars\/s/)).toBeVisible();
});
```

(Reuse the existing analysing e2e helper to reach Phase 1 — search `e2e/` for the spec that already exercises the analysing stage and copy its navigation/start steps; do not hand-roll a new flow.)

- [ ] **Step 3: Run the spec to verify it fails (before the mock change is complete) / passes after**

Run: `npx playwright test e2e/analysing-progress.spec.ts --project=chromium`
Expected: PASS once the mock emits the fields.

- [ ] **Step 4: Commit**

```bash
git add src/mocks/canned-data.ts e2e/analysing-progress.spec.ts
git commit -m "test(frontend): e2e for non-snapping attribution sentence count"
```

---

### Task A7: Update regression plan 216 (Wave A delta)

**Files:**
- Modify: `docs/features/216-analysing-local-analyzer-honesty.md`

- [ ] **Step 1: Add a sixth fix entry**

Append a "6. Per-chapter sentence progress" item to the fixes list describing: section-accumulated `Attributed ~N of ~M sentences` headline, `onSectionDone` accumulation, self-calibrated denominator, server-side `inSentenceMode` hysteresis, and the retained chars/s pulse. Cite the new files. Leave `status: active` (Wave B still pending).

- [ ] **Step 2: Commit**

```bash
git add docs/features/216-analysing-local-analyzer-honesty.md
git commit -m "docs(docs): record attribution sentence-progress in plan 216"
```

---

### Wave A checkpoint

- [ ] Run `npm run verify:quick` (all unit/integration tiers, no e2e/build) — green.
- [ ] Run `npm run test:e2e` — the new analysing spec green.
- [ ] **STOP for review.** Wave A is independently shippable (the sentence headline is the trustworthy win). Decide: open the PR now (A-only) or continue into Wave B on the same branch.

---

## Wave B — Honest ETA band + reload re-diagnosis

Hardens the flaky estimate (bugs 1 & 2) and re-diagnoses the reload-elapsed bug (bug 3). Bug 3 ships only after the reload is reproduced on the box.

### Task B1: Pure ETA-from-sentences + per-chapter band clamp

**Files:**
- Modify: `server/src/analyzer/sentence-progress.ts`
- Test: `server/src/analyzer/sentence-progress.test.ts`

**Interfaces:**
- Produces: `projectChapterEstMsFromSentences(elapsedMs: number, done: number, total: number): number | null`, `clampChapterEstMs(candidate: number | null, elapsedMs: number, lastGood: number, stageEstMs: number): number`

- [ ] **Step 1: Write the failing test (append)**

```ts
import { projectChapterEstMsFromSentences, clampChapterEstMs } from './sentence-progress.js';

describe('projectChapterEstMsFromSentences', () => {
  it('returns null before MIN_REFINE_ELAPSED (8s)', () => {
    expect(projectChapterEstMsFromSentences(5000, 50, 100)).toBeNull();
  });
  it('returns null below the 2% fraction floor', () => {
    expect(projectChapterEstMsFromSentences(20000, 1, 100)).toBeNull(); // 1% done
  });
  it('projects total from the fraction once meaningful', () => {
    // 10s elapsed at 25% done → ~40s total.
    expect(projectChapterEstMsFromSentences(10000, 25, 100)).toBe(40000);
  });
});

describe('clampChapterEstMs', () => {
  it('never returns below a floor just above elapsed', () => {
    expect(clampChapterEstMs(1000, 60000, 0, 600000)).toBeGreaterThan(60000);
  });
  it('falls back to lastGood when candidate is null', () => {
    expect(clampChapterEstMs(null, 10000, 90000, 600000)).toBe(90000);
  });
  it('never returns the whole-stage value', () => {
    expect(clampChapterEstMs(600000, 10000, 0, 600000)).toBeLessThan(600000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/sentence-progress.test.ts -t "FromSentences|clampChapterEstMs"`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Write minimal implementation (append)**

```ts
const MIN_REFINE_ELAPSED_MS = 8_000; // mirrors projectChapterEstMsFromOutput
const MIN_FRACTION = 0.02;

/** Project chapter total time from the sentence fraction. Null when too early
    (mirrors the byte projector's guards) so the caller keeps the prior value. */
export function projectChapterEstMsFromSentences(
  elapsedMs: number,
  done: number,
  total: number,
): number | null {
  if (elapsedMs < MIN_REFINE_ELAPSED_MS) return null;
  if (done < 1 || total <= 0) return null;
  const frac = Math.min(0.95, done / total);
  if (frac < MIN_FRACTION) return null;
  return Math.round(elapsedMs / frac);
}

/** Clamp an estimate into the per-chapter band: a floor that always sits just
    above elapsed (never "over budget"; reuse the refineCastChapterEstMs idiom),
    a fallback to the last good value when the candidate is null, and a ceiling
    that is never the whole-stage estimate (so the stage total can't leak into a
    chapter row). */
export function clampChapterEstMs(
  candidate: number | null,
  elapsedMs: number,
  lastGood: number,
  stageEstMs: number,
): number {
  const floor = Math.round(elapsedMs * 1.1) + 3000;
  const base = candidate ?? (lastGood > 0 ? lastGood : floor);
  const ceiling = stageEstMs > 0 ? stageEstMs * 0.9 : base;
  return Math.max(floor, Math.min(base, ceiling));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/analyzer/sentence-progress.test.ts -t "FromSentences|clampChapterEstMs"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/sentence-progress.ts server/src/analyzer/sentence-progress.test.ts
git commit -m "feat(server): sentence-fraction ETA + per-chapter estimate band"
```

---

### Task B2: Estimate precedence + band — pure selector, wired into the route (bugs 1 & 2)

The estimate-selection logic is the bug. Extract it into ONE pure function and unit-test the invariants there (no route harness — same reasoning as Task A4 Step 7). The route just calls it.

**Files:**
- Modify: `server/src/analyzer/sentence-progress.ts` (add `selectChapterEstMs`)
- Test: `server/src/analyzer/sentence-progress.test.ts`
- Modify: `server/src/routes/analysis.ts` (`InFlight` gains `lastGoodEstMs`; call the selector at the two refinement sites `:3417-3433` and `:3499-3510`)

**Interfaces:**
- Produces: `selectChapterEstMs(args: { elapsedMs; bySentenceMs: number | null; byBytesMs: number | null; lastGoodMs: number; stageEstMs: number }): number` — never null, never the stage value, always > elapsed.
- Consumes: `projectChapterEstMsFromSentences`, `clampChapterEstMs` (B1); `projectChapterEstMsFromOutput` (existing route fn — its result is passed in, keeping the selector pure).

- [ ] **Step 1: Write the failing test (append to sentence-progress.test.ts)**

```ts
import { selectChapterEstMs } from './sentence-progress.js';

describe('selectChapterEstMs (estimate-band invariants — bugs 1 & 2)', () => {
  const stage = 600_000; // whole-stage value that must NEVER appear in a chapter row
  it('prefers the sentence projection over bytes', () => {
    const r = selectChapterEstMs({ elapsedMs: 10_000, bySentenceMs: 40_000, byBytesMs: 99_000, lastGoodMs: 50_000, stageEstMs: stage });
    expect(r).toBe(40_000);
  });
  it('falls back to bytes, then last-good, when earlier signals are null', () => {
    expect(selectChapterEstMs({ elapsedMs: 10_000, bySentenceMs: null, byBytesMs: 70_000, lastGoodMs: 50_000, stageEstMs: stage })).toBe(70_000);
    expect(selectChapterEstMs({ elapsedMs: 10_000, bySentenceMs: null, byBytesMs: null, lastGoodMs: 50_000, stageEstMs: stage })).toBe(50_000);
  });
  it('never returns null/blank, never the stage value, always > elapsed', () => {
    const r = selectChapterEstMs({ elapsedMs: 120_000, bySentenceMs: stage, byBytesMs: null, lastGoodMs: 0, stageEstMs: stage });
    expect(r).toBeGreaterThan(120_000);
    expect(r).toBeLessThan(stage);
    expect(r).toBeTypeOf('number');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run src/analyzer/sentence-progress.test.ts -t selectChapterEstMs`
Expected: FAIL — `selectChapterEstMs is not a function`.

- [ ] **Step 3: Implement the pure selector (append to sentence-progress.ts)**

```ts
/** Choose the per-chapter estimate for a tick and clamp it to the band.
    Precedence: sentence projection → byte projection → last-good. Pure: the
    projection results are computed by the caller and passed in (the byte
    projector lives in analysis.ts), so this stays free of route state. */
export function selectChapterEstMs(args: {
  elapsedMs: number;
  bySentenceMs: number | null;
  byBytesMs: number | null;
  lastGoodMs: number;
  stageEstMs: number;
}): number {
  const candidate = args.bySentenceMs ?? args.byBytesMs;
  return clampChapterEstMs(candidate, args.elapsedMs, args.lastGoodMs, args.stageEstMs);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd server && npx vitest run src/analyzer/sentence-progress.test.ts -t selectChapterEstMs`
Expected: PASS.

- [ ] **Step 5: Wire the route**

Add `lastGoodEstMs: number` to `InFlight` (seed `= chapterEstMs` in the `inFlight.set` of Task A4). Define a local helper in `runChapter` and call it from BOTH refinement sites (`tickOverall` `:3417` and the throttled `onChunk` `:3501`), replacing the inline `projectChapterEstMsFromOutput` blocks:

```ts
      const refineEstMs = (slot: InFlight, elapsed: number) => {
        const prog = sentenceProgressForTick({
          committedSentences: slot.committedSentences,
          committedChars: slot.committedChars,
          inflightSentences: slot.inflightSentences,
          totalChars: ch.body.length,
          heuristicTotal: slot.heuristicTotal,
        });
        const next = selectChapterEstMs({
          elapsedMs: elapsed,
          bySentenceMs: projectChapterEstMsFromSentences(elapsed, prog.sentencesDone, prog.sentencesTotal),
          byBytesMs: projectChapterEstMsFromOutput(elapsed, slot.receivedBytes, ch.body.length, currentOutputRatio()),
          lastGoodMs: slot.lastGoodEstMs,
          stageEstMs: stage2EstMs,
        });
        slot.chapterEstMs = next;
        slot.lastGoodEstMs = next;
      };
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd server && npx vitest run src/analyzer/sentence-progress.test.ts` (PASS) and `npm run typecheck` (the route wiring compiles).

- [ ] **Step 7: Commit**

```bash
git add server/src/analyzer/sentence-progress.ts server/src/analyzer/sentence-progress.test.ts server/src/routes/analysis.ts
git commit -m "fix(server): stabilise per-chapter ETA with a sentence-aware band"
```

---

### Task B3: Frontend — never render a bare `of ~`

**Files:**
- Modify: `src/components/analysing/phase-card.tsx:74-77` (the `of ~est` clause in `LiveChapterRow`)
- Test: `src/components/analysing/phase-card.test.tsx`

- [ ] **Step 1: Write the failing test (append)**

```tsx
it('hides the "of ~est" clause when estMs is missing', () => {
  renderCard({
    live: { totalChapters: 9, chapters: [{ chapterIndex: 1, chapterTitle: 'Chapter 1', elapsedMs: 5000, estMs: 0 }] },
  });
  expect(screen.queryByText(/of ~/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/analysing/phase-card.test.tsx -t "hides the"`
Expected: FAIL — currently renders `of ~0:00`.

- [ ] **Step 3: Implement**

Replace the time clause (`:75-77`) so the `of ~est` part only renders with a positive estimate:

```tsx
        <span>
          {humanSecondsCompact(displayMs)}
          {chapter.estMs > 0 ? ` of ~${humanSecondsCompact(chapter.estMs)}` : ''}
        </span>
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/components/analysing/phase-card.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/analysing/phase-card.tsx src/components/analysing/phase-card.test.tsx
git commit -m "fix(frontend): never render a bare 'of ~' when the estimate is absent"
```

---

### Task B4: Reload elapsed — diagnose the replay buffer, then fix if real

**Diagnosis groundwork (from adversarial review).** `replayCatchUp` (`analysis.ts:1827`) replays only `job.replay.lastPhase` (plus logs/eta/cast/series/failed) — it forwards whatever `live` payload `lastPhase` happens to hold. So whether a reconnect shows live elapsed hinges entirely on **whether `job.replay.lastPhase` is refreshed on every `sendLiveTick`**. There is NO reusable end-to-end route harness to simulate a real reconnect, so diagnose at the buffer level instead.

**Files:**
- Investigate: `server/src/routes/analysis.ts` — find the site that ASSIGNS `job.replay.lastPhase` (search `replay.lastPhase =`), and confirm whether the `kind: 'phase'` events emitted by `sendLiveTick` flow through it (vs. only major phase transitions).
- Test: `server/src/routes/analysis.test.ts` (buffer-level — `replayCatchUp` is a small near-pure function: build a fake `job` with a `replay` object and a capturing `send`).
- Modify (only if the gap is real): the `lastPhase` assignment so live-tick phase events refresh it, and/or `replayCatchUp`.

- [ ] **Step 1: Diagnose at the buffer level.** Write a test that constructs a fake `job` whose `replay.lastPhase` is a `phaseId: 1` event carrying `live.chapters: [{ chapterIndex: 1, elapsedMs: 302000, … }]`, calls `replayCatchUp(job, capture)`, and asserts the captured events include that live chapter with its `elapsedMs`. This pins `replayCatchUp`'s forwarding contract.

Run: `cd server && npx vitest run --config vitest.config.slow.ts src/routes/analysis.test.ts -t "replayCatchUp forwards live"`
Expected: PASS (it already forwards `lastPhase`) — confirming the forwarding works.

- [ ] **Step 2: Locate the real gap (manual read, no test yet).** Read the `replay.lastPhase =` assignment site. **Decision point:**
  - If `sendLiveTick`'s phase events DO update `lastPhase` → the buffer is fresh; the reload symptom is NOT here (likely a frontend re-derivation). **STOP, report to the user, re-scope bug 3 — do not invent a server fix.**
  - If only major phase transitions update `lastPhase` (live ticks bypass it) → that's the bug: on reconnect mid-chapter the client gets a stale phase with no/empty `live`. Proceed to Step 3.

- [ ] **Step 3: Fix (only if Step 2 found the gap).** Make `sendLiveTick`'s phase event refresh `job.replay.lastPhase` (so the latest in-flight `live` snapshot is always the one replayed). Add a buffer-level regression test: after a simulated live tick updates the replay buffer, `replayCatchUp` emits the current chapter rows.

Run: `cd server && npx vitest run --config vitest.config.slow.ts src/routes/analysis.test.ts -t "replay"`
Expected: PASS.

- [ ] **Step 4: Commit (or report).** If fixed:

```bash
git add server/src/routes/analysis.ts server/src/routes/analysis.test.ts
git commit -m "fix(server): refresh replay snapshot on live ticks so reload keeps elapsed"
```

If Step 2 found the buffer already fresh, commit only the diagnostic test and report the re-scope to the user:

```bash
git add server/src/routes/analysis.test.ts
git commit -m "test(server): pin replayCatchUp live-row forwarding (bug 3 re-scoped)"
```

---

### Task B5: Update plan 216 (Wave B delta) + final verify

**Files:**
- Modify: `docs/features/216-analysing-local-analyzer-honesty.md`

- [ ] **Step 1: Record the estimate-band + reload fixes** in plan 216 (or note bug 3 re-scoped if Step B4.1 didn't reproduce). Keep `status: active` until on-box acceptance.

- [ ] **Step 2: Full battery.**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build green.

- [ ] **Step 3: Commit**

```bash
git add docs/features/216-analysing-local-analyzer-honesty.md
git commit -m "docs(docs): record ETA-band + reload fixes in plan 216"
```

---

## Known deviations from the spec (flagged for the user)

- **Display layout:** the spec's single-line `Attributed … · 24 chars/s · … · 3:09 of ~15:13` is illustrative. The real UI keeps chars/s in the separate `HeartbeatRow` (existing) and renders the sentence headline + bar inside `LiveChapterRow`. chars/s is preserved; the two simply live on adjacent lines, not one.
- **Byte-`%` fallback:** the spec shows `Receiving response · 38% · …` pre-threshold. The implementation uses the existing `HeartbeatRow` (`KB · chars/s · last chunk`) as the pre-threshold liveness display and does not add a separate `%` (which would need a server-side expected-bytes calc). Trivial to add later if wanted.

## Adversarial-review fixes folded into this revision (v2)

Three code-grounded probes overturned four assumptions in the first draft:

1. **`committedChars` accounting bug (BLOCKER).** Adding a section's chars at section *start* but its sentences at section *done* diluted the rate and collapsed the denominator mid-section. Fixed: `currentSectionChars` stashed at start, committed in lockstep with sentences at `onSectionDone` (Task A4 step 6).
2. **Frontend tests crash without a Redux Provider (BLOCKER).** `PhaseCard` calls `useAppSelector` unconditionally and `PhaseModelChip`/`PhaseModelSwap` render for `phaseId: 1`. Fixed: all frontend tests route through a `renderCard()` helper wrapping `<Provider store={mountStore()}>` (the file's existing pattern); `AnalysisPhase` fixture now includes the required `duration` field (A5/B3).
3. **No reusable Phase-1 route-integration harness exists (BLOCKER).** The first draft told the engineer to "copy the Phase-1 scaffold" — there isn't one (explicit blocker comment in `analysis.test.ts`). Fixed by following the codebase's actual pattern (pure exported helpers, e.g. `castInFlightEntryToLiveChapter`): logic lives in pure fns (`sentenceProgressForTick`, `selectChapterEstMs`) unit-tested directly; the route seam is covered by the e2e (A6). Tasks A4 step 7 and B2 restructured; no fabricated route harness.
4. **Reload bug-3 murkier than stated (SHOULD-FIX).** `replayCatchUp` forwards only `lastPhase`; whether elapsed survives depends on whether live ticks refresh `lastPhase`. B4 reframed to diagnose that assignment site at the buffer level, with an explicit STOP-and-re-scope branch if the buffer is already fresh.

Line-number citations in `analysis.ts` were spot-checked exact (±0).

## Known deviations from the spec (flagged for the user)

(See the dedicated section above — display layout keeps chars/s in `HeartbeatRow`; no literal byte-`%`.)

## Self-Review

- **Spec coverage:** numerator/section-accumulation (A3/A4), `"characterId":` marker (A1), self-calibrating denominator (A2/A4), chars/s retention (A5 guard + A6), display threshold + server-side hysteresis (A4 `inSentenceMode` + A5), `onSectionDone` + InFlight interface deltas (A3/A4), sentence-fraction ETA + band (B1/B2), bare-`of ~` fix (B3), reload re-diagnosis (B4), testable estimate invariants (B1/B2 pure), e2e at the seam (A6), plan-216 update (A7/B5). All spec sections map to a task.
- **Type consistency:** `sentencesDone`/`sentencesTotal`/`inSentenceMode`/`sectionsDone`/`sectionsTotal` used identically in `AnalysisLiveChapter` (A4), the route payload (A4), and the component (A5). `onSectionDone(index, sentenceCount)` identical in chunker (A3), `attributeChapterStage2` (A3), and route (A4). `countSentencesHeuristic`/`countStreamedSentences`/`refineSentencesTotal`/`sentenceProgressForTick`/`projectChapterEstMsFromSentences`/`clampChapterEstMs`/`selectChapterEstMs` signatures match across definition and call sites.
- **Test strategy:** every assertion is either a pure-fn unit test (server) wrapped-Provider component test (frontend), or the one e2e at the real seam — no test depends on a nonexistent route harness.
- **Placeholder scan:** every code step shows real code; investigation-only steps (B4) are explicitly diagnose-first with a STOP branch, not deferred implementation.
