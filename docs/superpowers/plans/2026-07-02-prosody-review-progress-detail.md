# Prosody + Script-Review Progress Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add chapter counts ("Chapter 3 of 12") and a pace-based ETA ("~2m left") to the Detect-emotions and Review-Script progress surfaces, replacing today's bare percentage.

**Architecture:** Three server SSE routes (`annotate-emotion.ts`, `instruct-annotation.ts`, `script-review.ts`) track an observed ms/char pacing rate per pass and emit `chapterIndex`/`totalChapters`/`estRemainingMs` on every `phase` event. These flow through `api.ts`'s SSE parsers into two Redux slices' `SubstageEntry` shape, through a selector, into the Status-popover and two inline running chips (existing "Detect emotions" chip, and a brand-new "Review Script" chip). `prosody-thunk.ts` reconciles the fact that "Detect emotions" is actually two full passes (emotion then instruct) into one combined, non-resetting ETA. A single pure formatter (`src/lib/substage-progress-text.ts`) renders the enriched text identically everywhere it appears.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, Express (SSE), Vitest + React Testing Library, Playwright.

## Global Constraints

- `chapterIndex` is the **1-based sequential position** among the chapters a pass processes — never the raw manuscript `chapterId`.
- Server-side pacing is observed-rate-based (ms/char), computed fresh per route — **no** fixed per-chapter overhead baseline, no floor/clamp, no cross-resume persistence (unlike `server/src/routes/analysis.ts`'s heavier precedent). This is a deliberately coarser estimate.
- `estRemainingMs` is **absent** on a route's first chapter (no observed rate yet) and absent entirely when that pass processes only 1 chapter.
- ETA text never ticks down client-side — it only changes when a new server phase event arrives (no `setInterval` countdown).
- The compact top-bar Status pill (`summarizeStatus`, the `Analysing · N%` chip) is explicitly **out of scope** — it stays terse. Only the Status-popover and the two inline running chips get the enriched text.
- "Detect emotions" is two full passes (emotion, then instruct) over the same chapters. The **counter** stays per-pass (never a fake `1..2N`); the **ETA** is combined across both passes by `prosody-thunk.ts` per the reconciliation rule in Task 9.
- `detect-emotions-button.tsx` keeps its existing local React state — it is **not** migrated to read from Redux (that state also drives the throttle/inter-pass/terminal-summary/error renders, which have no Redux equivalent).
- Full design rationale, including the two rounds of adversarial review: `docs/superpowers/specs/2026-07-02-prosody-review-progress-detail-design.md`.

---

## Task 1: Shared progress-text formatter

**Files:**
- Create: `src/lib/substage-progress-text.ts`
- Test: `src/lib/substage-progress-text.test.ts`

**Interfaces:**
- Produces: `formatChapterCount(chapterIndex?: number, totalChapters?: number): string | null`, `formatEtaClause(estRemainingMs?: number): string | null`, `formatSubstageDetail(entry: { chapterIndex?: number; totalChapters?: number; estRemainingMs?: number }): string | null` — consumed by Tasks 12, 13, 14.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { formatChapterCount, formatEtaClause, formatSubstageDetail } from './substage-progress-text';

describe('formatChapterCount', () => {
  it('formats a multi-chapter position', () => {
    expect(formatChapterCount(3, 12)).toBe('Chapter 3 of 12');
  });
  it('returns null for a single-chapter pass', () => {
    expect(formatChapterCount(1, 1)).toBeNull();
  });
  it('returns null when either field is missing', () => {
    expect(formatChapterCount(undefined, 12)).toBeNull();
    expect(formatChapterCount(3, undefined)).toBeNull();
  });
});

describe('formatEtaClause', () => {
  it('returns null when no estimate exists', () => {
    expect(formatEtaClause(undefined)).toBeNull();
  });
  it('renders under a minute as "less than a minute left"', () => {
    expect(formatEtaClause(0)).toBe('less than a minute left');
    expect(formatEtaClause(59_000)).toBe('less than a minute left');
  });
  it('renders minutes', () => {
    expect(formatEtaClause(60_000)).toBe('~1m left');
    expect(formatEtaClause(125_000)).toBe('~2m left');
  });
  it('renders hours and minutes', () => {
    expect(formatEtaClause(3_600_000)).toBe('~1h left');
    expect(formatEtaClause(3_900_000)).toBe('~1h 5m left');
  });
});

describe('formatSubstageDetail', () => {
  it('joins both clauses with a middle dot', () => {
    expect(formatSubstageDetail({ chapterIndex: 3, totalChapters: 12, estRemainingMs: 125_000 })).toBe(
      'Chapter 3 of 12 · ~2m left',
    );
  });
  it('omits the missing clause', () => {
    expect(formatSubstageDetail({ chapterIndex: 1, totalChapters: 12 })).toBe('Chapter 1 of 12');
    expect(formatSubstageDetail({ estRemainingMs: 30_000 })).toBe('less than a minute left');
  });
  it('returns null when nothing is available', () => {
    expect(formatSubstageDetail({})).toBeNull();
    expect(formatSubstageDetail({ chapterIndex: 1, totalChapters: 1 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/substage-progress-text.test.ts`
Expected: FAIL — `Cannot find module './substage-progress-text'`

- [ ] **Step 3: Write the implementation**

```ts
/** Pure formatters for the enriched prosody/script-review substage progress
    text (chapter counts + pace-based ETA). Shared across the Status-popover
    substage row, the Detect-emotions inline chip, and the Review-Script
    inline chip so all three surfaces render identical copy. */

export function formatChapterCount(chapterIndex?: number, totalChapters?: number): string | null {
  if (chapterIndex === undefined || totalChapters === undefined) return null;
  if (totalChapters <= 1) return null;
  return `Chapter ${chapterIndex} of ${totalChapters}`;
}

export function formatEtaClause(estRemainingMs?: number): string | null {
  if (estRemainingMs === undefined) return null;
  const totalSec = Math.round(estRemainingMs / 1000);
  if (totalSec < 60) return 'less than a minute left';
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `~${totalMin}m left`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `~${h}h ${m}m left` : `~${h}h left`;
}

export function formatSubstageDetail(entry: {
  chapterIndex?: number;
  totalChapters?: number;
  estRemainingMs?: number;
}): string | null {
  const parts = [
    formatChapterCount(entry.chapterIndex, entry.totalChapters),
    formatEtaClause(entry.estRemainingMs),
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(' · ') : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/substage-progress-text.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add src/lib/substage-progress-text.ts src/lib/substage-progress-text.test.ts
git commit -m "feat(frontend): add substage progress-text formatter"
```

---

## Task 2: Widen `prosody-slice.ts`'s `SubstageEntry`

**Files:**
- Modify: `src/store/prosody-slice.ts`
- Test: `src/store/prosody-slice.test.ts`

**Interfaces:**
- Produces: `SubstageEntry { progress; label; chapterIndex?; totalChapters?; estRemainingMs? }` — consumed by Task 3 (imports the type), Task 4 (selector), Task 9 (thunk dispatch shape), Task 13 (button dispatch shape).
- `setActive` / `updateProgress` payloads gain the same three optional fields; a field absent from the payload leaves the stored value unchanged (last-known-value semantics). `updateProgress` also newly accepts an optional `label`.

- [ ] **Step 1: Write the failing test**

Add to `src/store/prosody-slice.test.ts` (inside the existing `describe('prosody-slice (per-book map)', ...)` block, after the existing tests):

```ts
  it('setActive stores chapterIndex/totalChapters/estRemainingMs when provided', () => {
    const s = reduce([
      prosodyActions.setActive({
        bookId: 'b1',
        progress: 0,
        label: 'Detecting emotions',
        chapterIndex: 1,
        totalChapters: 12,
      }),
    ]);
    expect(s.activeStreams.b1).toEqual<SubstageEntry>({
      progress: 0,
      label: 'Detecting emotions',
      chapterIndex: 1,
      totalChapters: 12,
    });
  });

  it('updateProgress updates only the fields it is given, leaving others intact', () => {
    const s = reduce([
      prosodyActions.setActive({
        bookId: 'b1',
        progress: 0,
        label: 'Detecting emotions',
        chapterIndex: 1,
        totalChapters: 12,
      }),
      prosodyActions.updateProgress({ bookId: 'b1', progress: 0.5, estRemainingMs: 60_000 }),
    ]);
    expect(s.activeStreams.b1).toEqual<SubstageEntry>({
      progress: 50,
      label: 'Detecting emotions',
      chapterIndex: 1,
      totalChapters: 12,
      estRemainingMs: 60_000,
    });
    const s2 = prosodySlice.reducer(
      s,
      prosodyActions.updateProgress({ bookId: 'b1', progress: 0.6, chapterIndex: 2, label: 'Detecting instruct' }),
    );
    expect(s2.activeStreams.b1).toEqual<SubstageEntry>({
      progress: 60,
      label: 'Detecting instruct',
      chapterIndex: 2,
      totalChapters: 12,
      estRemainingMs: 60_000, // untouched — this update didn't carry a new one
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/prosody-slice.test.ts`
Expected: FAIL — TypeScript error (payload does not accept `chapterIndex`) or assertion mismatch (extra fields absent from stored entry).

- [ ] **Step 3: Write the implementation**

Replace the full contents of `src/store/prosody-slice.ts`:

```ts
/* Prosody slice — transient UI-only progress for the two-pass prosody
   annotation run (Phase 3, fs-65).

   Progress is a per-book map so concurrent multi-book passes never collide.
   Like `notifications`, this slice is TRANSIENT: UI-only, no persistence.
   Its progress map IS broadcast cross-tab via the `sync:substage` message in
   broadcast-middleware (Generate-gate consistency); the inbound
   applyExternalSet/applyExternalClear reducers are deliberately NOT in the
   middleware's outbound match set so they can't re-broadcast (echo layer 2).
   Results land in the manuscript slice, not here. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface SubstageEntry {
  /** 0..100 integer percent. */
  progress: number;
  /** User-facing phase label, e.g. "Detecting emotions". */
  label: string;
  /** 1-based sequential position among the chapters THIS PASS processes. */
  chapterIndex?: number;
  /** Count of chapters this pass processes. */
  totalChapters?: number;
  /** Pace-based ETA in ms for the rest of the operation. Absent until a
      pacing rate has been observed (never on the very first chapter). */
  estRemainingMs?: number;
}

export interface ProsodyState {
  activeStreams: Record<string, SubstageEntry>;
}

const initialState: ProsodyState = { activeStreams: {} };

interface SetActivePayload {
  bookId: string;
  progress: number;
  label: string;
  chapterIndex?: number;
  totalChapters?: number;
  estRemainingMs?: number;
}
interface UpdateProgressPayload {
  bookId: string;
  progress: number;
  label?: string;
  chapterIndex?: number;
  totalChapters?: number;
  estRemainingMs?: number;
}

export const prosodySlice = createSlice({
  name: 'prosody',
  initialState,
  reducers: {
    setActive: (s, a: PayloadAction<SetActivePayload>) => {
      const { bookId, progress, label, chapterIndex, totalChapters, estRemainingMs } = a.payload;
      s.activeStreams[bookId] = {
        progress: Math.round(progress * 100),
        label,
        ...(chapterIndex !== undefined ? { chapterIndex } : {}),
        ...(totalChapters !== undefined ? { totalChapters } : {}),
        ...(estRemainingMs !== undefined ? { estRemainingMs } : {}),
      };
    },
    updateProgress: (s, a: PayloadAction<UpdateProgressPayload>) => {
      const e = s.activeStreams[a.payload.bookId];
      if (!e) return;
      e.progress = Math.round(a.payload.progress * 100);
      if (a.payload.label !== undefined) e.label = a.payload.label;
      if (a.payload.chapterIndex !== undefined) e.chapterIndex = a.payload.chapterIndex;
      if (a.payload.totalChapters !== undefined) e.totalChapters = a.payload.totalChapters;
      if (a.payload.estRemainingMs !== undefined) e.estRemainingMs = a.payload.estRemainingMs;
    },
    clear: (s, a: PayloadAction<{ bookId: string }>) => {
      delete s.activeStreams[a.payload.bookId];
    },
    /** Inbound from broadcast — NEVER add to the outbound match set. */
    applyExternalSet: (s, a: PayloadAction<{ bookId: string; entry: SubstageEntry }>) => {
      s.activeStreams[a.payload.bookId] = a.payload.entry;
    },
    applyExternalClear: (s, a: PayloadAction<{ bookId: string }>) => {
      delete s.activeStreams[a.payload.bookId];
    },
  },
});

export const prosodyActions = prosodySlice.actions;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/prosody-slice.test.ts`
Expected: PASS (all cases, including the pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add src/store/prosody-slice.ts src/store/prosody-slice.test.ts
git commit -m "feat(frontend): widen prosody SubstageEntry with chapter/ETA fields"
```

---

## Task 3: Widen `script-review-slice.ts`'s `activeStreams` reducers

**Files:**
- Modify: `src/store/script-review-slice.ts`
- Test: `src/store/script-review-slice.test.ts`

**Interfaces:**
- Consumes: `SubstageEntry` from Task 2.
- Produces: `setActive` / `updateProgress` payloads mirroring Task 2's shape exactly (symmetric with prosody-slice) — consumed by Task 10 (thunk).

- [ ] **Step 1: Write the failing test**

Add to `src/store/script-review-slice.test.ts` (inside the existing `describe('script-review-slice activeStreams', ...)` block):

```ts
  it('setActive/updateProgress store and update chapterIndex/totalChapters/estRemainingMs', () => {
    const s = reduceR([
      scriptReviewActions.setActive({
        bookId: 'b1',
        progress: 0,
        label: 'Reviewing script',
        chapterIndex: 1,
        totalChapters: 3,
      }),
      scriptReviewActions.updateProgress({
        bookId: 'b1',
        progress: 0.5,
        chapterIndex: 2,
        totalChapters: 3,
        estRemainingMs: 20_000,
      }),
    ]);
    expect(s.activeStreams.b1).toEqual<SubstageEntry>({
      progress: 50,
      label: 'Reviewing script',
      chapterIndex: 2,
      totalChapters: 3,
      estRemainingMs: 20_000,
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/script-review-slice.test.ts`
Expected: FAIL — TypeScript error (payload does not accept `chapterIndex`)

- [ ] **Step 3: Write the implementation**

In `src/store/script-review-slice.ts`, replace the `setActive` and `updateProgress` reducers (lines 94–105) with:

```ts
    /** Start or restart a review-progress stream for one book. progress is 0..1. */
    setActive: (
      s,
      a: PayloadAction<{
        bookId: string;
        progress: number;
        label: string;
        chapterIndex?: number;
        totalChapters?: number;
        estRemainingMs?: number;
      }>,
    ) => {
      const { bookId, progress, label, chapterIndex, totalChapters, estRemainingMs } = a.payload;
      s.activeStreams[bookId] = {
        progress: Math.round(progress * 100),
        label,
        ...(chapterIndex !== undefined ? { chapterIndex } : {}),
        ...(totalChapters !== undefined ? { totalChapters } : {}),
        ...(estRemainingMs !== undefined ? { estRemainingMs } : {}),
      };
    },
    /** Update the progress fraction (0..1) for an in-flight stream. No-op if not active. */
    updateProgress: (
      s,
      a: PayloadAction<{
        bookId: string;
        progress: number;
        label?: string;
        chapterIndex?: number;
        totalChapters?: number;
        estRemainingMs?: number;
      }>,
    ) => {
      const e = s.activeStreams[a.payload.bookId];
      if (!e) return;
      e.progress = Math.round(a.payload.progress * 100);
      if (a.payload.label !== undefined) e.label = a.payload.label;
      if (a.payload.chapterIndex !== undefined) e.chapterIndex = a.payload.chapterIndex;
      if (a.payload.totalChapters !== undefined) e.totalChapters = a.payload.totalChapters;
      if (a.payload.estRemainingMs !== undefined) e.estRemainingMs = a.payload.estRemainingMs;
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/script-review-slice.test.ts`
Expected: PASS (all cases, including the pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add src/store/script-review-slice.ts src/store/script-review-slice.test.ts
git commit -m "feat(frontend): widen script-review SubstageEntry with chapter/ETA fields"
```

---

## Task 4: Widen `selectAnalysisSubstage`

**Files:**
- Modify: `src/store/analysis-substage-selectors.ts`
- Test: `src/store/analysis-substage-selectors.test.ts`

**Interfaces:**
- Consumes: `SubstageEntry` (Tasks 2–3).
- Produces: `selectAnalysisSubstage(state): { kind; label; percent; chapterIndex?; totalChapters?; estRemainingMs? } | null` — consumed by Task 11 (`layout.tsx`).

- [ ] **Step 1: Write the failing test**

Add to `src/store/analysis-substage-selectors.test.ts` (after the existing tests, before the closing of the `describe` block):

```ts
  it('selectAnalysisSubstage passes chapterIndex/totalChapters/estRemainingMs through', () => {
    const s = mk(
      {
        b1: {
          progress: 40,
          label: 'Detecting emotions',
          chapterIndex: 3,
          totalChapters: 12,
          estRemainingMs: 60_000,
        } as never,
      },
      {},
    );
    expect(selectAnalysisSubstage(s)).toEqual({
      kind: 'prosody',
      label: 'Detecting emotions',
      percent: 40,
      chapterIndex: 3,
      totalChapters: 12,
      estRemainingMs: 60_000,
    });
  });

  it('omits chapterIndex/totalChapters/estRemainingMs when the entry lacks them', () => {
    const s = mk({}, { b5: { progress: 12, label: 'Reviewing script' } });
    expect(selectAnalysisSubstage(s)).toEqual({
      kind: 'review',
      label: 'Reviewing script',
      percent: 12,
      chapterIndex: undefined,
      totalChapters: undefined,
      estRemainingMs: undefined,
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/analysis-substage-selectors.test.ts`
Expected: FAIL — returned object lacks `chapterIndex`/`totalChapters`/`estRemainingMs`

- [ ] **Step 3: Write the implementation**

Replace `selectAnalysisSubstage` in `src/store/analysis-substage-selectors.ts`:

```ts
/** Memoized so an unchanged map returns a stable reference (avoids the
    "selector returned a different result" re-render churn). Prefers a prosody
    pass over a review pass; ties broken by lowest bookId. */
export const selectAnalysisSubstage = createSelector(
  [(s: RootState) => s.prosody.activeStreams, (s: RootState) => s.scriptReview.activeStreams],
  (
    prosody,
    review,
  ): {
    kind: 'prosody' | 'review';
    label: string;
    percent: number;
    chapterIndex?: number;
    totalChapters?: number;
    estRemainingMs?: number;
  } | null => {
    const p = firstByLowestBookId(prosody);
    if (p)
      return {
        kind: 'prosody',
        label: p.entry.label,
        percent: p.entry.progress,
        chapterIndex: p.entry.chapterIndex,
        totalChapters: p.entry.totalChapters,
        estRemainingMs: p.entry.estRemainingMs,
      };
    const r = firstByLowestBookId(review);
    if (r)
      return {
        kind: 'review',
        label: r.entry.label,
        percent: r.entry.progress,
        chapterIndex: r.entry.chapterIndex,
        totalChapters: r.entry.totalChapters,
        estRemainingMs: r.entry.estRemainingMs,
      };
    return null;
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/analysis-substage-selectors.test.ts`
Expected: PASS (all cases, including the pre-existing ones — the pre-existing exact-equality tests must be updated too, see note below)

**Note:** the pre-existing tests `'selectAnalysisSubstage prefers prosody...'` and `'falls back to review...'` use `toEqual({kind, label, percent})` (no `chapterIndex`/`totalChapters`/`estRemainingMs` keys at all). Since the selector now always includes those three keys (as `undefined` when absent from the entry), and `toEqual` treats an object with explicit `undefined` values as equal to one where the keys are simply missing, these two pre-existing assertions **remain passing unchanged** — Vitest's `toEqual` ignores `undefined`-valued properties. No edit needed to those two tests.

- [ ] **Step 5: Commit**

```bash
git add src/store/analysis-substage-selectors.ts src/store/analysis-substage-selectors.test.ts
git commit -m "feat(frontend): widen selectAnalysisSubstage with chapter/ETA fields"
```

---

## Task 5: Server pacing — `annotate-emotion.ts`

**Files:**
- Modify: `server/src/routes/annotate-emotion.ts:132-220`
- Test: `server/src/routes/annotate-emotion.test.ts`

**Interfaces:**
- Produces: SSE `phase` events now carry `chapterIndex` (1-based), `totalChapters`, and `estRemainingMs` (from the 2nd chapter onward); `label` is now the plain phase verb (`"Detecting emotions"`, no chapter suffix) — consumed by Task 8 (`api.ts` parser).

- [ ] **Step 1: Write the failing test**

Add to `server/src/routes/annotate-emotion.test.ts` (inside the `describe('POST /api/books/:bookId/annotate-emotion', ...)` block, after the existing tests):

```ts
  it('carries chapterIndex/totalChapters on every phase event, and estRemainingMs only from the 2nd chapter onward', async () => {
    writeBook(SENTENCES); // 2 chapters
    runEmotion.mockImplementation(async (_m, chapterId): Promise<EmotionAnnotationOutput> => {
      await new Promise((r) => setTimeout(r, 20));
      return chapterId === 1
        ? { annotations: [{ sentenceId: 2, emotion: 'angry' }] }
        : { annotations: [{ sentenceId: 3, emotion: 'sad' }] };
    });

    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    const events = parseSse(res.text);
    const phases = events.filter((e) => e.kind === 'phase' && typeof e.chapterId === 'number');

    expect(phases[0]).toMatchObject({ chapterIndex: 1, totalChapters: 2 });
    expect(phases[0].estRemainingMs).toBeUndefined();
    expect(phases[1]).toMatchObject({ chapterIndex: 2, totalChapters: 2 });
    expect(typeof phases[1].estRemainingMs).toBe('number');
    expect(phases[1].estRemainingMs as number).toBeGreaterThanOrEqual(0);
  });

  it('drops the "— chapter N" suffix from the phase label', async () => {
    writeBook(SENTENCES);
    runEmotion.mockResolvedValue({ annotations: [] });
    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    const events = parseSse(res.text);
    const phases = events.filter((e) => e.kind === 'phase' && typeof e.chapterId === 'number');
    expect(phases.every((e) => e.label === 'Detecting emotions')).toBe(true);
  });

  it('a failed chapter still contributes its wall-clock duration to the next chapter estimate', async () => {
    writeBook(SENTENCES);
    runEmotion.mockImplementation(async (_m, chapterId): Promise<EmotionAnnotationOutput> => {
      await new Promise((r) => setTimeout(r, 20));
      if (chapterId === 1) throw new Error('flaky chapter');
      return { annotations: [{ sentenceId: 3, emotion: 'sad' }] };
    });
    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    const events = parseSse(res.text);
    const phases = events.filter((e) => e.kind === 'phase' && typeof e.chapterId === 'number');
    // Chapter 1 failed but still took real time — chapter 2's phase event still gets an estimate.
    expect(typeof phases[1].estRemainingMs).toBe('number');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/annotate-emotion.test.ts`
Expected: FAIL — `phases[0].chapterIndex` is `undefined`; label still contains `"— chapter 1"`

- [ ] **Step 3: Write the implementation**

In `server/src/routes/annotate-emotion.ts`, replace lines 132–213 (from `let totalAnnotations = 0;` through the closing `} finally { clearInterval(keepAlive); }` of the main try block) with:

```ts
    let totalAnnotations = 0;
    let annotatedChapters = 0;
    let actualMsTotal = 0;
    let actualCharsTotal = 0;
    const charsByChapter = new Map<number, number>(
      chapterIds.map((id) => [id, (byChapter.get(id) ?? []).reduce((n, sent) => n + sent.text.length, 0)]),
    );
    try {
      for (let i = 0; i < chapterIds.length; i += 1) {
        if (closed) break;
        const chapterId = chapterIds[i];
        const phaseEvent: Record<string, unknown> = {
          kind: 'phase',
          phaseId: 0,
          progress: i / chapterIds.length,
          label: 'Detecting emotions',
          chapterId,
          chapterIndex: i + 1,
          totalChapters: chapterIds.length,
        };
        if (actualCharsTotal > 0) {
          const observedRate = actualMsTotal / actualCharsTotal;
          const remainingChars = chapterIds
            .slice(i)
            .reduce((n, id) => n + (charsByChapter.get(id) ?? 0), 0);
          phaseEvent.estRemainingMs = Math.round(observedRate * remainingChars);
        }
        send(phaseEvent);

        const chapterStartedAt = Date.now();
        const sentences = byChapter.get(chapterId) ?? [];
        const chunks = chunkSentencesByBudget(sentences, {
          charBudget: chapterChunkBudget(selection.engine),
          overlap: 3,
          serialize: (s) =>
            JSON.stringify({ sentenceId: s.id, characterId: s.characterId, text: s.text }),
        });

        try {
          for (const chunk of chunks) {
            if (closed) break;
            const prompt = buildEmotionChapterInbox(
              manuscriptId,
              chapterId,
              chunkWithContext(chunk),
            );
            const result = await selection.analyzer.runEmotionChapter(
              manuscriptId,
              chapterId,
              prompt,
              {
                signal: controller.signal,
                onChunk: (info) =>
                  heartbeat(0, chapterId, {
                    receivedBytes: info.receivedBytes,
                    elapsedMs: info.elapsedMs,
                    sinceLastChunkMs: info.sinceLastChunkMs,
                  }),
                onThrottle: (waitMs, reason) =>
                  send({
                    kind: 'throttle',
                    phaseId: 0,
                    chapterIndex: chapterId,
                    model: selection.model,
                    waitMs,
                    reason,
                  }),
              },
            );
            const owned = result.annotations.filter((a) => chunk.coreIds.has(a.sentenceId));
            if (owned.length) {
              send({ kind: 'annotation', chapterId, annotations: owned });
              totalAnnotations += owned.length;
            }
          }
          annotatedChapters += 1;
        } catch (err) {
          if (err instanceof AnalysisAbortedError) break;
          if (err instanceof DailyQuotaExhaustedError) {
            send({
              kind: 'error',
              code: 'quota_exhausted',
              message:
                'Daily analyzer quota exhausted. Already-detected chapters are applied — re-run to finish.',
              resetAt: err.resetAt instanceof Date ? err.resetAt.toISOString() : undefined,
            });
            clearInterval(keepAlive);
            if (!closed) res.end();
            return;
          }
          /* One bad chapter shouldn't kill the whole pass — report it and
             carry on so the rest of the book still gets annotated. */
          send({ kind: 'chapter-failed', chapterId, message: (err as Error).message });
        } finally {
          /* A failed chapter still took real wall-clock time — count it
             toward the pacing rate so the next chapter's ETA stays honest. */
          actualMsTotal += Date.now() - chapterStartedAt;
          actualCharsTotal += charsByChapter.get(chapterId) ?? 0;
        }
      }
    } finally {
      clearInterval(keepAlive);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/routes/annotate-emotion.test.ts`
Expected: PASS (all cases, including the pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/annotate-emotion.ts server/src/routes/annotate-emotion.test.ts
git commit -m "feat(server): add chapter counts + pace-based ETA to annotate-emotion phase events"
```

---

## Task 6: Server pacing — `instruct-annotation.ts`

**Files:**
- Modify: `server/src/routes/instruct-annotation.ts:131-213`
- Test: `server/src/routes/instruct-annotation.test.ts`

**Interfaces:**
- Produces: identical shape to Task 5, for the instruct pass (`label: 'Detecting instruct'`).

- [ ] **Step 1: Write the failing test**

Add to `server/src/routes/instruct-annotation.test.ts` (inside its main `describe`, mirroring Task 5's three tests — check the file's exact fixture/mock names first, e.g. `SENTENCES`, `runStage3`, `Stage3ChapterOutput`):

```ts
  it('carries chapterIndex/totalChapters on every phase event, and estRemainingMs only from the 2nd chapter onward', async () => {
    writeBook(SENTENCES); // 2 chapters
    runStage3.mockImplementation(async (_m, chapterId): Promise<Stage3ChapterOutput> => {
      await new Promise((r) => setTimeout(r, 20));
      return chapterId === 1
        ? { annotations: [{ sentenceId: 2 }] }
        : { annotations: [{ sentenceId: 3 }] };
    });

    const res = await request(app).post(`/api/books/${bookId}/instruct-annotation`).send({});
    const events = parseSse(res.text);
    const phases = events.filter((e) => e.kind === 'phase' && typeof e.chapterId === 'number');

    expect(phases[0]).toMatchObject({ chapterIndex: 1, totalChapters: 2 });
    expect(phases[0].estRemainingMs).toBeUndefined();
    expect(phases[1]).toMatchObject({ chapterIndex: 2, totalChapters: 2 });
    expect(typeof phases[1].estRemainingMs).toBe('number');
  });

  it('drops the "— chapter N" suffix from the phase label', async () => {
    writeBook(SENTENCES);
    runStage3.mockResolvedValue({ annotations: [] });
    const res = await request(app).post(`/api/books/${bookId}/instruct-annotation`).send({});
    const events = parseSse(res.text);
    const phases = events.filter((e) => e.kind === 'phase' && typeof e.chapterId === 'number');
    expect(phases.every((e) => e.label === 'Detecting instruct')).toBe(true);
  });

  it('a failed chapter still contributes its wall-clock duration to the next chapter estimate', async () => {
    writeBook(SENTENCES);
    runStage3.mockImplementation(async (_m, chapterId): Promise<Stage3ChapterOutput> => {
      await new Promise((r) => setTimeout(r, 20));
      if (chapterId === 1) throw new Error('flaky chapter');
      return { annotations: [{ sentenceId: 3 }] };
    });
    const res = await request(app).post(`/api/books/${bookId}/instruct-annotation`).send({});
    const events = parseSse(res.text);
    const phases = events.filter((e) => e.kind === 'phase' && typeof e.chapterId === 'number');
    expect(typeof phases[1].estRemainingMs).toBe('number');
  });
```

Check the actual field names on `Stage3ChapterOutput`'s `annotations` entries (likely `{ sentenceId; text?; instruct?; vocalization? }` per `api.ts`'s `DetectInstructOpts`) and adjust the mock's return shape to satisfy the real type if `tsc`/vitest complains — the exact annotation payload contents don't matter for these three tests, only that the call resolves.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/instruct-annotation.test.ts`
Expected: FAIL — `phases[0].chapterIndex` is `undefined`; label still contains `"— chapter 1"`

- [ ] **Step 3: Write the implementation**

In `server/src/routes/instruct-annotation.ts`, replace lines 131–213 (from `let totalAnnotations = 0;` through the closing `} finally { clearInterval(keepAlive); }` — do NOT include the `if (!closed) { send('Done'); send result; res.end(); }` block at lines 214–219, which stays untouched below the replacement) with the same structure as Task 5, swapping the analyzer call and label:

```ts
    let totalAnnotations = 0;
    let annotatedChapters = 0;
    let actualMsTotal = 0;
    let actualCharsTotal = 0;
    const charsByChapter = new Map<number, number>(
      chapterIds.map((id) => [id, (byChapter.get(id) ?? []).reduce((n, sent) => n + sent.text.length, 0)]),
    );
    try {
      for (let i = 0; i < chapterIds.length; i += 1) {
        if (closed) break;
        const chapterId = chapterIds[i];
        const phaseEvent: Record<string, unknown> = {
          kind: 'phase',
          phaseId: 0,
          progress: i / chapterIds.length,
          label: 'Detecting instruct',
          chapterId,
          chapterIndex: i + 1,
          totalChapters: chapterIds.length,
        };
        if (actualCharsTotal > 0) {
          const observedRate = actualMsTotal / actualCharsTotal;
          const remainingChars = chapterIds
            .slice(i)
            .reduce((n, id) => n + (charsByChapter.get(id) ?? 0), 0);
          phaseEvent.estRemainingMs = Math.round(observedRate * remainingChars);
        }
        send(phaseEvent);

        const chapterStartedAt = Date.now();
        const sentences = byChapter.get(chapterId) ?? [];
        const chunks = chunkSentencesByBudget(sentences, {
          charBudget: chapterChunkBudget(selection.engine),
          overlap: 3,
          serialize: (s) =>
            JSON.stringify({ sentenceId: s.id, characterId: s.characterId, text: s.text }),
        });

        try {
          for (const chunk of chunks) {
            if (closed) break;
            const prompt = buildInstructChapterInbox(
              manuscriptId,
              chapterId,
              chunkWithContext(chunk),
            );
            const result = await selection.analyzer.runStage3Chapter(
              manuscriptId,
              chapterId,
              prompt,
              {
                signal: controller.signal,
                onChunk: (info) =>
                  heartbeat(0, chapterId, {
                    receivedBytes: info.receivedBytes,
                    elapsedMs: info.elapsedMs,
                    sinceLastChunkMs: info.sinceLastChunkMs,
                  }),
                onThrottle: (waitMs, reason) =>
                  send({
                    kind: 'throttle',
                    phaseId: 0,
                    chapterIndex: chapterId,
                    model: selection.model,
                    waitMs,
                    reason,
                  }),
              },
            );
            const owned = result.annotations.filter((a) => chunk.coreIds.has(a.sentenceId));
            if (owned.length) {
              send({ kind: 'annotation', chapterId, annotations: owned });
              totalAnnotations += owned.length;
            }
          }
          annotatedChapters += 1;
        } catch (err) {
          if (err instanceof AnalysisAbortedError) break;
          if (err instanceof DailyQuotaExhaustedError) {
            send({
              kind: 'error',
              code: 'quota_exhausted',
              message:
                'Daily analyzer quota exhausted. Already-detected chapters are applied — re-run to finish.',
              resetAt: err.resetAt instanceof Date ? err.resetAt.toISOString() : undefined,
            });
            clearInterval(keepAlive);
            if (!closed) res.end();
            return;
          }
          send({ kind: 'chapter-failed', chapterId, message: (err as Error).message });
        } finally {
          actualMsTotal += Date.now() - chapterStartedAt;
          actualCharsTotal += charsByChapter.get(chapterId) ?? 0;
        }
      }
    } finally {
      clearInterval(keepAlive);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/routes/instruct-annotation.test.ts`
Expected: PASS (all cases, including the pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/instruct-annotation.ts server/src/routes/instruct-annotation.test.ts
git commit -m "feat(server): add chapter counts + pace-based ETA to instruct-annotation phase events"
```

---

## Task 7: Server pacing — `script-review.ts`

**Files:**
- Modify: `server/src/routes/script-review.ts:286-382`
- Test: `server/src/routes/script-review.test.ts`

**Interfaces:**
- Produces: identical shape to Tasks 5–6 (`label: 'Reviewing script'`), but bracketed around the **whole per-chapter chunk loop** (script-review chunks each get their own try/catch, unlike the other two routes' single try/catch per chapter) so a per-chunk `chapter-failed` doesn't skip the timing update. Single-chapter review (`chapterId` in the request body) never emits `estRemainingMs` (falls out automatically: at `i=0`, `actualCharsTotal` is still `0`).

- [ ] **Step 1: Write the failing test**

Add to `server/src/routes/script-review.test.ts` (inside its main `describe`, using the existing `SENTENCES`/`runReview`/`CANNED_OPS` fixtures):

```ts
  it('carries chapterIndex/totalChapters on every phase event, and estRemainingMs only from the 2nd chapter onward', async () => {
    writeBook(SENTENCES); // 2 chapters
    runReview.mockImplementation(async (): Promise<ScriptReviewOutput> => {
      await new Promise((r) => setTimeout(r, 20));
      return { ops: [] };
    });

    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    const events = parseSse(res.text);
    const phases = events.filter((e) => e.kind === 'phase' && typeof e.chapterId === 'number');

    expect(phases[0]).toMatchObject({ chapterIndex: 1, totalChapters: 2 });
    expect(phases[0].estRemainingMs).toBeUndefined();
    expect(phases[1]).toMatchObject({ chapterIndex: 2, totalChapters: 2 });
    expect(typeof phases[1].estRemainingMs).toBe('number');
  });

  it('drops the "— chapter N" suffix from the phase label', async () => {
    writeBook(SENTENCES);
    runReview.mockResolvedValue({ ops: [] });
    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    const events = parseSse(res.text);
    const phases = events.filter((e) => e.kind === 'phase' && typeof e.chapterId === 'number');
    expect(phases.every((e) => e.label === 'Reviewing script')).toBe(true);
  });

  it('never emits estRemainingMs for a single-chapter review', async () => {
    writeBook(SENTENCES);
    runReview.mockResolvedValue(CANNED_OPS);
    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 1 });
    const events = parseSse(res.text);
    const phases = events.filter((e) => e.kind === 'phase' && typeof e.chapterId === 'number');
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ chapterIndex: 1, totalChapters: 1 });
    expect(phases[0].estRemainingMs).toBeUndefined();
  });

  it('a failed chunk still contributes its wall-clock duration to the next chapter estimate', async () => {
    writeBook(SENTENCES);
    runReview.mockImplementation(async (_m, chapterId): Promise<ScriptReviewOutput> => {
      await new Promise((r) => setTimeout(r, 20));
      if (chapterId === 1) throw new Error('flaky chapter');
      return { ops: [] };
    });
    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    const events = parseSse(res.text);
    const phases = events.filter((e) => e.kind === 'phase' && typeof e.chapterId === 'number');
    expect(typeof phases[1].estRemainingMs).toBe('number');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/script-review.test.ts`
Expected: FAIL — `phases[0].chapterIndex` is `undefined`; label still contains `"— chapter 1"`

- [ ] **Step 3: Write the implementation**

In `server/src/routes/script-review.ts`, replace lines 286–382 (from `let totalOps = 0;` through the closing `} finally { clearInterval(keepAlive); }` — the `for` loop's own closing brace is at line 379, one line before the `finally`; do NOT stop there) with:

```ts
    let totalOps = 0;
    let reviewedChapters = 0;
    let actualMsTotal = 0;
    let actualCharsTotal = 0;
    const charsByChapter = new Map<number, number>(
      chapterIds.map((id) => [id, (byChapter.get(id) ?? []).reduce((n, sent) => n + sent.text.length, 0)]),
    );
    try {
      for (let i = 0; i < chapterIds.length; i += 1) {
        if (closed) break;
        const chapterId = chapterIds[i];
        const phaseEvent: Record<string, unknown> = {
          kind: 'phase',
          phaseId: 0,
          progress: i / chapterIds.length,
          label: 'Reviewing script',
          chapterId,
          chapterIndex: i + 1,
          totalChapters: chapterIds.length,
        };
        if (actualCharsTotal > 0) {
          const observedRate = actualMsTotal / actualCharsTotal;
          const remainingChars = chapterIds
            .slice(i)
            .reduce((n, id) => n + (charsByChapter.get(id) ?? 0), 0);
          phaseEvent.estRemainingMs = Math.round(observedRate * remainingChars);
        }
        send(phaseEvent);

        const chapterStartedAt = Date.now();

        /* fs-64 — the prior chapter's final exchange (read-only) resolves a
           tagless chapter-opening line. Null unless the immediately-preceding
           non-excluded chapter ends in a live A/B exchange. */
        const priorId = priorChapterIdFor(chapterId, allChapterIds, excludedChapterIds);
        const priorExchange =
          priorId !== null ? priorChapterBoundaryExchange(byChapter.get(priorId) ?? [], roster) : null;

        /* Split the chapter's sentences into budgeted chunks (one call each).
           The owned-core rule keeps each sentence reviewed exactly once across
           the overlapping context windows. A cloud engine gets a huge budget so
           the whole chapter is a single chunk (unchanged behaviour). */
        const chunks = chunkSentencesByBudget(byChapter.get(chapterId) ?? [], {
          charBudget: chapterChunkBudget(selection.engine),
          overlap: 3,
          serialize: (s) => JSON.stringify({ id: s.id, characterId: s.characterId, text: s.text }),
        });

        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          if (closed) break;
          const prompt = buildScriptReviewChapterInbox(
            manuscriptId,
            chapterId,
            chunkWithContext(chunk),
            roster,
            index === 0 ? priorExchange : null,
          );
          try {
            const result = await selection.analyzer.runScriptReviewChapter(
              manuscriptId,
              chapterId,
              prompt,
              {
                signal: controller.signal,
                language: bookStateLanguage(located.state),
                onChunk: (info) =>
                  heartbeat(0, chapterId, {
                    receivedBytes: info.receivedBytes,
                    elapsedMs: info.elapsedMs,
                    sinceLastChunkMs: info.sinceLastChunkMs,
                  }),
                onThrottle: (waitMs, reason) =>
                  send({
                    kind: 'throttle',
                    phaseId: 0,
                    chapterIndex: chapterId,
                    model: selection.model,
                    waitMs,
                    reason,
                  }),
              },
            );
            /* Emit only the ops this chunk OWNS (primary sentence in its core),
               so a sentence appearing in another chunk's context isn't emitted twice. */
            const owned = result.ops.filter((op) => ownsOp(chunk.coreIds, primarySentenceId(op)));
            if (owned.length) {
              send({ kind: 'ops', chapterId, ops: owned });
              totalOps += owned.length;
            }
          } catch (err) {
            if (err instanceof AnalysisAbortedError) break;
            if (err instanceof DailyQuotaExhaustedError) {
              send({
                kind: 'error',
                code: 'quota_exhausted',
                message:
                  'Daily analyzer quota exhausted. Already-reviewed chapters are streamed — re-run to finish.',
                resetAt: err.resetAt instanceof Date ? err.resetAt.toISOString() : undefined,
              });
              clearInterval(keepAlive);
              if (!closed) res.end();
              return;
            }
            /* One bad chunk shouldn't kill the whole pass — report it and
               carry on so the rest of the book still gets reviewed. */
            send({ kind: 'chapter-failed', chapterId, message: (err as Error).message });
          }
        }
        /* A failed chunk still took real wall-clock time — count it toward
           the pacing rate so the next chapter's ETA stays honest. */
        actualMsTotal += Date.now() - chapterStartedAt;
        actualCharsTotal += charsByChapter.get(chapterId) ?? 0;
        reviewedChapters += 1;
      }
    } finally {
      clearInterval(keepAlive);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/routes/script-review.test.ts`
Expected: PASS (all cases, including the pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/script-review.ts server/src/routes/script-review.test.ts
git commit -m "feat(server): add chapter counts + pace-based ETA to script-review phase events"
```

---

## Task 8: Client SSE parsing + mocks — `api.ts`

**Files:**
- Modify: `src/lib/api.ts` (three `onPhase` type + parser pairs, three mock functions)
- Test: `src/lib/api-detect-emotions.test.ts`, `src/lib/api-review-script.test.ts`

**Interfaces:**
- Consumes: server phase-event shape from Tasks 5–7.
- Produces: `DetectEmotionsOpts.onPhase`, `DetectInstructOpts.onPhase`, `ReviewScriptOpts.onPhase` all gain `chapterIndex?: number; totalChapters?: number; estRemainingMs?: number` — consumed by Task 9 (`prosody-thunk.ts`) and Task 10 (`script-review-thunk.ts`). Mocks (`mockDetectEmotions`, `mockDetectInstruct`, `mockReviewScript`) emit the same fields so `VITE_USE_MOCKS` mode and e2e (Task 15) can exercise the feature.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/api-detect-emotions.test.ts` (inside `describe('api.detectEmotions', ...)`, after the existing `'parses phase + annotation events...'` test):

```ts
  it('parses chapterIndex/totalChapters/estRemainingMs from a phase event', async () => {
    const { api } = await import('./api');
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        JSON.stringify({
          kind: 'phase',
          progress: 0.5,
          label: 'Detecting emotions',
          chapterId: 3,
          chapterIndex: 3,
          totalChapters: 12,
          estRemainingMs: 60_000,
        }),
        JSON.stringify({ kind: 'result', annotatedChapters: 1, totalAnnotations: 1 }),
      ]),
    );
    const phases: Array<{ chapterIndex?: number; totalChapters?: number; estRemainingMs?: number }> = [];
    await api.detectEmotions('book-1', { onPhase: (e) => phases.push(e) });
    expect(phases[0]).toMatchObject({ chapterIndex: 3, totalChapters: 12, estRemainingMs: 60_000 });
  });
```

Add to `src/lib/api-review-script.test.ts` (a new `describe` block):

```ts
describe('realReviewScript — chapter/ETA fields', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('parses chapterIndex/totalChapters/estRemainingMs from a phase event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      JSON.stringify({
        kind: 'phase',
        progress: 0.33,
        label: 'Reviewing script',
        chapterId: 2,
        chapterIndex: 2,
        totalChapters: 3,
        estRemainingMs: 20_000,
      }),
      JSON.stringify({ kind: 'result', done: true, reviewedChapters: 1, totalOps: 0 }),
    ])));
    const { api } = await import('./api');
    const phases: Array<{ chapterIndex?: number; totalChapters?: number; estRemainingMs?: number }> = [];
    await api.reviewScript('bk', { onPhase: (e) => phases.push(e) });
    expect(phases[0]).toMatchObject({ chapterIndex: 2, totalChapters: 3, estRemainingMs: 20_000 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/api-detect-emotions.test.ts src/lib/api-review-script.test.ts`
Expected: FAIL — `phases[0].chapterIndex` is `undefined`

- [ ] **Step 3: Write the implementation**

In `src/lib/api.ts`, apply the same three edits to `DetectEmotionsOpts`/`realDetectEmotions`, `DetectInstructOpts`/`realDetectInstruct`, and `ReviewScriptOpts`/`realReviewScript`:

Widen each `onPhase` type (e.g. `DetectEmotionsOpts`, line 2676):
```ts
  onPhase?: (e: {
    progress: number;
    label?: string;
    chapterId?: number;
    chapterIndex?: number;
    totalChapters?: number;
    estRemainingMs?: number;
  }) => void;
```
(repeat for `DetectInstructOpts` at line 2810 and `ReviewScriptOpts` at line 2950)

Widen each `'phase'` case in the corresponding `handle` function (e.g. `realDetectEmotions`, lines 2718–2726):
```ts
      case 'phase':
        if (typeof p.progress === 'number') {
          onPhase?.({
            progress: p.progress,
            label: typeof p.label === 'string' ? p.label : undefined,
            chapterId: typeof p.chapterId === 'number' ? p.chapterId : undefined,
            chapterIndex: typeof p.chapterIndex === 'number' ? p.chapterIndex : undefined,
            totalChapters: typeof p.totalChapters === 'number' ? p.totalChapters : undefined,
            estRemainingMs: typeof p.estRemainingMs === 'number' ? p.estRemainingMs : undefined,
          });
        }
        break;
```
(apply the identical `'phase'` case body to `realDetectInstruct`'s handler at lines 2852–2860 and `realReviewScript`'s handler at lines 2992–3000)

Replace `mockDetectEmotions` (lines 2788–2802):
```ts
async function mockDetectEmotions(
  _bookId: string,
  { onPhase, onAnnotation, onChapterFailed: _onChapterFailed }: DetectEmotionsOpts = {},
): Promise<DetectEmotionsResult> {
  await wait(60);
  onPhase?.({ progress: 0.25, label: 'Detecting emotions', chapterId: 1, chapterIndex: 1, totalChapters: 2 });
  await wait(500);
  onPhase?.({ progress: 0.5, label: 'Detecting emotions', chapterId: 1, chapterIndex: 1, totalChapters: 2 });
  onAnnotation?.({ chapterId: 1, annotations: [{ sentenceId: 1, emotion: 'excited' }] });
  await wait(500);
  onPhase?.({
    progress: 0.85,
    label: 'Detecting emotions',
    chapterId: 2,
    chapterIndex: 2,
    totalChapters: 2,
    estRemainingMs: 15_000,
  });
  await wait(500);
  onPhase?.({ progress: 1, label: 'Done' });
  return { annotatedChapters: 1, totalAnnotations: 1 };
}
```

Replace `mockDetectInstruct` (lines 2927–2941):
```ts
async function mockDetectInstruct(
  _bookId: string,
  { onPhase, onAnnotation, onChapterFailed: _onChapterFailed }: DetectInstructOpts = {},
): Promise<DetectInstructResult> {
  await wait(60);
  onPhase?.({ progress: 0.5, label: 'Detecting instruct', chapterId: 1, chapterIndex: 1, totalChapters: 1 });
  await wait(500);
  onAnnotation?.({
    chapterId: 1,
    annotations: [{ sentenceId: 1, text: '[laughs]', instruct: 'warm, amused', vocalization: true }],
  });
  await wait(400);
  onPhase?.({ progress: 1, label: 'Done' });
  return { annotatedChapters: 1, totalAnnotations: 1 };
}
```

In `mockReviewScript` (lines 3058–3067), replace the four `onPhase?.(...)` calls only (leave the `onOps?.(...)` calls below them unchanged):
```ts
  await wait(60);
  onPhase?.({ progress: 0.25, label: 'Reviewing script', chapterId: 1, chapterIndex: 1, totalChapters: 3 });
  await wait(500);
  onPhase?.({
    progress: 0.5,
    label: 'Reviewing script',
    chapterId: 3,
    chapterIndex: 2,
    totalChapters: 3,
    estRemainingMs: 20_000,
  });
  await wait(500);
  onPhase?.({
    progress: 0.85,
    label: 'Reviewing script',
    chapterId: 3,
    chapterIndex: 3,
    totalChapters: 3,
    estRemainingMs: 5_000,
  });
  await wait(400);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/api-detect-emotions.test.ts src/lib/api-review-script.test.ts`
Expected: PASS (all cases, including the pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/api-detect-emotions.test.ts src/lib/api-review-script.test.ts
git commit -m "feat(frontend): parse chapter/ETA fields in SSE phase events + update mocks"
```

---

## Task 9: Two-pass ETA reconciliation — `prosody-thunk.ts`

**Files:**
- Modify: `src/store/prosody-thunk.ts`
- Test: `src/store/prosody-thunk.test.ts`

**Interfaces:**
- Consumes: `DetectEmotionsOpts.onPhase` / `DetectInstructOpts.onPhase` (Task 8).
- Produces: `RunProsodyPassesOpts.onProgress: (fraction: number, detail?: SubstageDetail) => void` where `SubstageDetail = { label?: string; chapterIndex?: number; totalChapters?: number; estRemainingMs?: number }` — consumed by Task 13 (`detect-emotions-button.tsx`).

- [ ] **Step 1: Write the failing test**

Add to `src/store/prosody-thunk.test.ts` (after the existing tests, before the closing `});` of the `describe` block):

```ts
  it('combines pass-1 remaining + pass-1-total-as-pass-2-proxy for the ETA while pass 1 runs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.mocked(api.detectEmotions).mockImplementation(
      async (_bookId: string, opts: DetectEmotionsOpts = {}) => {
        vi.setSystemTime(4000); // 4s elapsed since pass 1 started
        opts.onPhase?.({ progress: 0.5, estRemainingMs: 1000 });
        return EMPTY_EMOTIONS;
      },
    );
    vi.mocked(api.detectInstruct).mockResolvedValue(EMPTY_INSTRUCT);

    const dispatch = vi.fn();
    const details: Array<{ estRemainingMs?: number } | undefined> = [];
    await runProsodyPasses(bookId, { dispatch, onProgress: (_f, d) => details.push(d) });
    vi.useRealTimers();

    // combined = own-remaining(1000) + pass1-total-as-proxy(elapsed 4000 + remaining 1000) = 6000
    expect(details[0]?.estRemainingMs).toBe(6000);
  });

  it('freezes at the pass-1 projection until pass 2 produces its own estimate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.mocked(api.detectEmotions).mockImplementation(
      async (_bookId: string, opts: DetectEmotionsOpts = {}) => {
        vi.setSystemTime(2000);
        opts.onPhase?.({ progress: 1, estRemainingMs: 0 }); // pass 1 finishing
        return EMPTY_EMOTIONS;
      },
    );
    vi.mocked(api.detectInstruct).mockImplementation(
      async (_bookId: string, opts: DetectInstructOpts = {}) => {
        opts.onPhase?.({ progress: 0.1 }); // pass 2's first chapter — no own estimate yet
        return EMPTY_INSTRUCT;
      },
    );

    const dispatch = vi.fn();
    const details: Array<{ estRemainingMs?: number } | undefined> = [];
    await runProsodyPasses(bookId, { dispatch, onProgress: (_f, d) => details.push(d) });
    vi.useRealTimers();

    // pass-1 combined = 0 + (elapsed 2000 + remaining 0) = 2000; frozen through pass 2's first tick
    expect(details[0]?.estRemainingMs).toBe(2000);
    expect(details[1]?.estRemainingMs).toBe(2000);
  });

  it('uses pass 2 own estRemainingMs once pass 2 reports one, ignoring the pass-1 proxy', async () => {
    vi.mocked(api.detectEmotions).mockResolvedValue(EMPTY_EMOTIONS); // no onPhase calls
    vi.mocked(api.detectInstruct).mockImplementation(
      async (_bookId: string, opts: DetectInstructOpts = {}) => {
        opts.onPhase?.({ progress: 0.5, estRemainingMs: 500 });
        return EMPTY_INSTRUCT;
      },
    );

    const dispatch = vi.fn();
    const details: Array<{ estRemainingMs?: number } | undefined> = [];
    await runProsodyPasses(bookId, { dispatch, onProgress: (_f, d) => details.push(d) });

    expect(details[0]?.estRemainingMs).toBe(500);
  });

  it('forwards chapterIndex/totalChapters/label from each pass onProgress detail', async () => {
    vi.mocked(api.detectEmotions).mockImplementation(
      async (_bookId: string, opts: DetectEmotionsOpts = {}) => {
        opts.onPhase?.({ progress: 0.5, chapterIndex: 3, totalChapters: 12, label: 'Detecting emotions' });
        return EMPTY_EMOTIONS;
      },
    );
    vi.mocked(api.detectInstruct).mockResolvedValue(EMPTY_INSTRUCT);

    const dispatch = vi.fn();
    const details: Array<{ chapterIndex?: number; totalChapters?: number; label?: string } | undefined> = [];
    await runProsodyPasses(bookId, { dispatch, onProgress: (_f, d) => details.push(d) });

    expect(details[0]).toMatchObject({ chapterIndex: 3, totalChapters: 12, label: 'Detecting emotions' });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/prosody-thunk.test.ts`
Expected: FAIL — `details[0]` is `undefined` (onProgress not yet called with a second arg)

- [ ] **Step 3: Write the implementation**

Replace the full contents of `src/store/prosody-thunk.ts`:

```ts
/* Task 10 (fs-65 Phase 3) — reusable two-pass prosody annotation thunk.

   Extracted from DetectEmotionsButton.run so both the manual trigger
   (detect-emotions-button.tsx) and the eager auto-trigger (Task 13,
   layout.tsx) share the same implementation.

   Pass 1: api.detectEmotions — per-quote emotion backfill (fill-only-empty).
   Pass 2: api.detectInstruct — natural reactions / delivery instructions.

   Progress is reported on a 0–100% scale: emotions occupies 0–50%,
   instruct occupies 50–100%.

   "Detect emotions" is TWO full passes over the SAME chapters, so the
   chapter counter (chapterIndex/totalChapters) is passed through per-pass
   unmodified, but the ETA is reconciled here into one combined number:
   while pass 1 runs, the combined ETA is pass 1's own remaining time PLUS
   pass 1's own total-so-far (elapsed + remaining), used as a stand-in for
   pass 2's not-yet-measured duration. Once pass 1 finishes, the combined
   ETA becomes pass 2's own remaining time — and until pass 2 produces its
   own first estimate, the last pass-1-derived number is held frozen rather
   than dropped (avoids a false "no estimate" blip at the pass boundary).

   Returns a summary that is NEVER thrown away on partial failures.
   `failed` is load-bearing: Task 13 only writes the prosodyAnnotated
   watermark when failed === 0. */

import { manuscriptActions } from './manuscript-slice';
import { api } from '../lib/api';
import type { AppDispatch } from './index';

/** Structured detail accompanying an onProgress tick — the chapter counter
    (per-pass, unmodified) plus the already-reconciled combined ETA. */
export interface SubstageDetail {
  label?: string;
  chapterIndex?: number;
  totalChapters?: number;
  estRemainingMs?: number;
}

export interface RunProsodyPassesOpts {
  dispatch: AppDispatch;
  /** AbortSignal for cooperative cancellation (optional — Task 13 passes none). */
  signal?: AbortSignal;
  /** Called with 0–1 fraction as the two passes progress, plus the
   *  reconciled chapter/ETA detail for this tick. */
  onProgress?: (fraction: number, detail?: SubstageDetail) => void;
  /** Called with a human-readable status label from each pass's onPhase events,
   *  and with the inter-pass "Adding natural reactions…" message. Optional —
   *  Task 13 does not pass this. */
  onStatus?: (label: string) => void;
  /** Called when either pass emits an onThrottle event (rate-limit wait). Optional —
   *  Task 13 does not pass this. */
  onThrottle?: () => void;
}

export interface RunProsodyPassesResult {
  totalAnnotations: number;
  totalChapters: number;
  /** Number of chapters that failed (emitted a chapter-failed event). */
  failed: number;
}

/**
 * Run the two prosody annotation passes over the whole book.
 * Always resolves — never throws — so a partial failure is captured in
 * `failed` rather than propagating as an exception.
 */
export async function runProsodyPasses(
  bookId: string,
  { dispatch, signal, onProgress, onStatus, onThrottle }: RunProsodyPassesOpts,
): Promise<RunProsodyPassesResult> {
  let failed = 0;
  let combinedEstRemainingMs: number | undefined;
  const pass1StartedAt = Date.now();

  // Pass 1: emotion backfill — progress 0–50%
  const emotionResult = await api.detectEmotions(bookId, {
    signal,
    onPhase: (e) => {
      if (e.estRemainingMs !== undefined) {
        const elapsedSoFarPass1 = Date.now() - pass1StartedAt;
        const pass1TotalAsPass2Proxy = elapsedSoFarPass1 + e.estRemainingMs;
        combinedEstRemainingMs = e.estRemainingMs + pass1TotalAsPass2Proxy;
      }
      onProgress?.(e.progress * 0.5, {
        label: e.label,
        chapterIndex: e.chapterIndex,
        totalChapters: e.totalChapters,
        estRemainingMs: combinedEstRemainingMs,
      });
      if (e.label) onStatus?.(e.label);
    },
    onThrottle: () => onThrottle?.(),
    onAnnotation: (e) => dispatch(manuscriptActions.applyDetectedEmotions(e)),
    onChapterFailed: () => {
      failed++;
    },
  });

  // Inter-pass status label — mirrors the old button behaviour.
  onStatus?.('Adding natural reactions…');

  // Pass 2: instruct/vocalization — progress 50–100%
  const instructResult = await api.detectInstruct(bookId, {
    signal,
    onPhase: (e) => {
      if (e.estRemainingMs !== undefined) {
        combinedEstRemainingMs = e.estRemainingMs;
      }
      onProgress?.(0.5 + e.progress * 0.5, {
        label: e.label,
        chapterIndex: e.chapterIndex,
        totalChapters: e.totalChapters,
        estRemainingMs: combinedEstRemainingMs,
      });
      if (e.label) onStatus?.(e.label);
    },
    onThrottle: () => onThrottle?.(),
    onAnnotation: (e) => dispatch(manuscriptActions.applyDetectedInstruct(e)),
    onChapterFailed: () => {
      failed++;
    },
  });

  const totalAnnotations = emotionResult.totalAnnotations + instructResult.totalAnnotations;
  const totalChapters = Math.max(
    emotionResult.annotatedChapters,
    instructResult.annotatedChapters,
  );

  return { totalAnnotations, totalChapters, failed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/prosody-thunk.test.ts`
Expected: PASS (all cases, including the pre-existing ones — `'calls onProgress with 0–1 fraction during both passes'` still passes since it only reads the first callback argument)

- [ ] **Step 5: Commit**

```bash
git add src/store/prosody-thunk.ts src/store/prosody-thunk.test.ts
git commit -m "feat(frontend): reconcile Detect-emotions' two-pass ETA into one combined estimate"
```

---

## Task 10: Forward chapter/ETA fields — `script-review-thunk.ts`

**Files:**
- Modify: `src/store/script-review-thunk.ts:44-45`
- Test: `src/store/script-review-thunk.test.ts`

**Interfaces:**
- Consumes: `ReviewScriptOpts.onPhase` (Task 8), `scriptReviewActions.updateProgress` (Task 3).
- Produces: dispatched `updateProgress` payload now includes `label`/`chapterIndex`/`totalChapters`/`estRemainingMs` when the phase event carries them.

- [ ] **Step 1: Write the failing test**

Add to `src/store/script-review-thunk.test.ts` (after the existing tests, before the closing `});`):

```ts
  it('forwards label/chapterIndex/totalChapters/estRemainingMs from onPhase into updateProgress', async () => {
    vi.mocked(api.reviewScript).mockImplementation(
      async (_bookId: string, opts: ReviewScriptOpts = {}) => {
        opts.onPhase?.({
          progress: 0.5,
          label: 'Reviewing script',
          chapterIndex: 2,
          totalChapters: 3,
          estRemainingMs: 20_000,
        });
        return { reviewedChapters: 0, totalOps: 0 };
      },
    );
    const dispatch = vi.fn();
    await runReviewScript('b1', {
      dispatch,
      wholeBook: true,
      model: 'gemma',
      sentences: [],
      characterIds: new Set<string>(),
    });
    const progressCalls = dispatch.mock.calls
      .map((c) => c[0])
      .filter((a) => a.type === scriptReviewActions.updateProgress.type);
    expect(progressCalls[0].payload).toEqual({
      bookId: 'b1',
      progress: 0.5,
      label: 'Reviewing script',
      chapterIndex: 2,
      totalChapters: 3,
      estRemainingMs: 20_000,
    });
  });
```

Note: the pre-existing test `'sets active, forwards onPhase progress, then clears in finally on success'` calls `opts.onPhase?.({ progress: 0.5 })` / `opts.onPhase?.({ progress: 1 })` (no extra fields) and asserts `lastProg.payload` equals exactly `{ bookId: 'b1', progress: 1 }`. This test **must keep passing unmodified** — implement Step 3 with a conditional spread so an event without the extra fields dispatches a payload with exactly those two keys, not `undefined`-valued extras.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/script-review-thunk.test.ts`
Expected: FAIL — `progressCalls[0].payload` lacks `label`/`chapterIndex`/`totalChapters`/`estRemainingMs`

- [ ] **Step 3: Write the implementation**

In `src/store/script-review-thunk.ts`, replace the `onPhase` line (line 44–45):

```ts
      onPhase: ({ progress, label, chapterIndex, totalChapters, estRemainingMs }: {
        progress: number;
        label?: string;
        chapterIndex?: number;
        totalChapters?: number;
        estRemainingMs?: number;
      }) =>
        dispatch(
          scriptReviewActions.updateProgress({
            bookId,
            progress,
            ...(label !== undefined ? { label } : {}),
            ...(chapterIndex !== undefined ? { chapterIndex } : {}),
            ...(totalChapters !== undefined ? { totalChapters } : {}),
            ...(estRemainingMs !== undefined ? { estRemainingMs } : {}),
          }),
        ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/script-review-thunk.test.ts`
Expected: PASS (both the new test and the pre-existing exact-equality test)

- [ ] **Step 5: Commit**

```bash
git add src/store/script-review-thunk.ts src/store/script-review-thunk.test.ts
git commit -m "feat(frontend): forward chapter/ETA fields from script-review onPhase into Redux"
```

---

## Task 11: Thread the widened substage through `layout.tsx` / `top-bar.tsx` to the popover

**Files:**
- Modify: `src/components/layout.tsx:1439`
- Modify: `src/components/top-bar.tsx:168-170`

**Interfaces:**
- Consumes: `selectAnalysisSubstage` output (Task 4).
- Produces: `StatusDetail.analysisSubstage` now carries `chapterIndex?`/`totalChapters?`/`estRemainingMs?` — consumed by Task 12 (`status-popover.tsx`).

**Note on scope:** the compact top-bar Status pill (`StatusInput.analysisSubstage`, feeding `summarizeStatus`) is explicitly out of scope (it only ever renders `percent`) and is **not** touched here — `layout.tsx:1422`'s `{ kind: analysisSubstage.kind, percent: analysisSubstage.percent }` mapping stays exactly as-is. Only the popover-facing `StatusDetail` path widens. This task has no new dedicated test — Task 12's `status-popover.test.tsx` addition exercises the widened `StatusDetail` shape end-to-end, and Task 4's selector test covers the upstream data. Verification here is `npm run typecheck` plus the existing `layout.test.tsx` / `top-bar.test.tsx` suites staying green.

- [ ] **Step 1: Widen `StatusDetail.analysisSubstage`'s type**

In `src/components/top-bar.tsx`, replace lines 168–170 (the field's doc comment + declaration — do NOT include line 171, the `StatusDetail` interface's own closing `}`):

```ts
  /** The active analysis sub-stage (prosody/review) label + progress, or null/absent.
      Rendered as a secondary row inside the Analysis section of the popover. */
  analysisSubstage?: {
    label: string;
    percent: number;
    chapterIndex?: number;
    totalChapters?: number;
    estRemainingMs?: number;
  } | null;
```

- [ ] **Step 2: Pass the new fields through in `layout.tsx`**

In `src/components/layout.tsx`, replace line 1439:

```ts
    analysisSubstage: analysisSubstage
      ? {
          label: analysisSubstage.label,
          percent: analysisSubstage.percent,
          chapterIndex: analysisSubstage.chapterIndex,
          totalChapters: analysisSubstage.totalChapters,
          estRemainingMs: analysisSubstage.estRemainingMs,
        }
      : null,
```

- [ ] **Step 3: Verify typecheck and existing tests stay green**

Run: `npm run typecheck`
Expected: PASS (no type errors)

Run: `npx vitest run src/components/layout.test.tsx src/components/top-bar.test.tsx`
Expected: PASS (all pre-existing cases — neither file asserts on `analysisSubstage`'s extra fields today, so nothing to update)

- [ ] **Step 4: Commit**

```bash
git add src/components/layout.tsx src/components/top-bar.tsx
git commit -m "feat(frontend): thread chapter/ETA fields through to the Status-popover's StatusDetail"
```

---

## Task 12: Render the enriched substage row — `status-popover.tsx`

**Files:**
- Modify: `src/components/status-popover.tsx`
- Test: `src/components/status-popover.test.tsx`

**Interfaces:**
- Consumes: `formatSubstageDetail` (Task 1), `StatusDetail.analysisSubstage` (Task 11).

- [ ] **Step 1: Write the failing test**

Add to `src/components/status-popover.test.tsx` (after the existing tests, before the closing `});` of the `describe('StatusPopover', ...)` block):

```ts
  it('renders the chapter-count + ETA line under the substage label when present', () => {
    render(
      <StatusPopover
        {...makeProps({
          analysis: null,
          analysisSubstage: {
            label: 'Detecting emotions',
            percent: 40,
            chapterIndex: 3,
            totalChapters: 12,
            estRemainingMs: 125_000,
          },
        })}
      />,
    );
    expect(screen.getByTestId('substage-row').textContent).toContain('Detecting emotions');
    expect(screen.getByTestId('substage-detail').textContent).toBe('Chapter 3 of 12 · ~2m left');
  });

  it('omits the detail line when neither chapter count nor ETA is available', () => {
    render(
      <StatusPopover
        {...makeProps({
          analysis: null,
          analysisSubstage: { label: 'Detecting emotions', percent: 5 },
        })}
      />,
    );
    expect(screen.getByTestId('substage-row')).toBeInTheDocument();
    expect(screen.queryByTestId('substage-detail')).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/status-popover.test.tsx`
Expected: FAIL — `substage-detail` test id does not exist yet

- [ ] **Step 3: Write the implementation**

In `src/components/status-popover.tsx`, add the import near the top (after the existing `top-bar` import):

```ts
import { formatSubstageDetail } from '../lib/substage-progress-text';
```

Replace the `<Section title="Analysis" ...>` block (lines 165–199) with:

```tsx
      <Section title="Analysis" testid="status-popover-analysis">
        {analysis ? (
          <div className="flex flex-col items-start gap-1.5">
            <AnalysisPill data={{ ...analysis, onClick: onGoToAnalysing }} />
            {analysis.model && (
              <span
                data-testid="status-popover-analysis-model"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-ink/5 text-ink/70"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-ink/30" />
                <span className="tabular-nums">
                  {MODEL_OPTIONS.find((m) => m.id === analysis.model)?.label ?? analysis.model}
                </span>
              </span>
            )}
            {analysisSubstage && (
              <div data-testid="substage-row" className="flex flex-col gap-0.5 w-full">
                <div className="flex items-center justify-between text-sm text-ink/70">
                  <span>{analysisSubstage.label}</span>
                  <span className="tabular-nums">{analysisSubstage.percent}%</span>
                </div>
                {formatSubstageDetail(analysisSubstage) && (
                  <span data-testid="substage-detail" className="text-xs text-ink/50 tabular-nums">
                    {formatSubstageDetail(analysisSubstage)}
                  </span>
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            {analysisSubstage ? (
              <div data-testid="substage-row" className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between text-sm text-ink/70">
                  <span>{analysisSubstage.label}</span>
                  <span className="tabular-nums">{analysisSubstage.percent}%</span>
                </div>
                {formatSubstageDetail(analysisSubstage) && (
                  <span data-testid="substage-detail" className="text-xs text-ink/50 tabular-nums">
                    {formatSubstageDetail(analysisSubstage)}
                  </span>
                )}
              </div>
            ) : (
              <p className="text-sm text-ink/60">No analysis running.</p>
            )}
          </>
        )}
      </Section>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/status-popover.test.tsx`
Expected: PASS (all cases, including the pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add src/components/status-popover.tsx src/components/status-popover.test.tsx
git commit -m "feat(frontend): render chapter-count + ETA in the Status-popover substage row"
```

---

## Task 13: Detect-emotions inline chip — `detect-emotions-button.tsx`

**Files:**
- Modify: `src/components/detect-emotions-button.tsx`
- Test: `src/components/detect-emotions-button.test.tsx`

**Interfaces:**
- Consumes: `SubstageDetail` (Task 9), `formatSubstageDetail` (Task 1), `prosodyActions.updateProgress` (Task 2).

- [ ] **Step 1: Write the failing test**

Add to `src/components/detect-emotions-button.test.tsx` (inside the `describe('fs-33 — DetectEmotionsButton', ...)` block, after the existing tests):

```ts
  it('renders chapter count + the two-pass-reconciled ETA once onProgress supplies detail', async () => {
    /* The button runs the REAL runProsodyPasses (Task 9) — only api.detectEmotions/
       detectInstruct are mocked here. Task 9's reconciliation combines pass 1's own
       estRemainingMs with a projection of pass 2's full duration while pass 1 is
       still running: combined = own-remaining + (elapsed-so-far + own-remaining).
       With own-remaining = 125_000ms and elapsed-so-far ~0 (synchronous mock call),
       combined ≈ 250_000ms → "~4m left", NOT the raw 125_000ms/"~2m left" a
       single-pass reading would suggest. */
    detectEmotions.mockImplementation((_bookId: string, opts?: any) => {
      if (!opts) return Promise.resolve({ annotatedChapters: 0, totalAnnotations: 0 });
      opts.onPhase({ progress: 0.25, chapterIndex: 3, totalChapters: 12, estRemainingMs: 125_000 });
      return new Promise(() => {}); // stays running so the chip is on screen to assert on
    });
    detectInstruct.mockResolvedValue({ annotatedChapters: 0, totalAnnotations: 0 });
    const store = makeStore();
    render(
      <Provider store={store}>
        <DetectEmotionsButton />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('detect-emotions-button'));
    fireEvent.click(screen.getByTestId('detect-emotions-confirm'));

    await waitFor(() =>
      expect(screen.getByTestId('detect-emotions-progress-detail').textContent).toBe(
        'Chapter 3 of 12 · ~4m left',
      ),
    );
    // The Redux entry (feeding the Status-popover) picks up the same reconciled fields.
    // Compare with a tolerance rather than exact equality — real (non-fake) elapsed
    // time contributes a few ms of jitter on top of the 250_000ms base, which the
    // rounded-to-minutes display text absorbs but a byte-exact ms check would not.
    const entry = store.getState().prosody.activeStreams['b1'];
    expect(entry).toMatchObject({ chapterIndex: 3, totalChapters: 12 });
    expect(entry?.estRemainingMs).toBeGreaterThanOrEqual(250_000);
    expect(entry?.estRemainingMs).toBeLessThan(251_000);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/detect-emotions-button.test.tsx`
Expected: FAIL — `getByTestId('detect-emotions-progress-detail')` does not exist yet

- [ ] **Step 3: Write the implementation**

In `src/components/detect-emotions-button.tsx`:

Add imports (after the existing `prosody-slice` import):
```ts
import { type SubstageDetail } from '../store/prosody-thunk';
import { formatSubstageDetail } from '../lib/substage-progress-text';
```

Add local state (after the existing `const [status, setStatus] = useState<string | null>(null);`):
```ts
  const [detail, setDetail] = useState<SubstageDetail | undefined>(undefined);
```

In `run()`, reset it alongside the other reset lines (after `setProgress(0);`):
```ts
    setDetail(undefined);
```

Replace the `onProgress` call site inside `runProsodyPasses(...)`:
```ts
        onProgress: (fraction, d) => {
          setProgress(fraction);
          setDetail(d);
          dispatch(
            prosodyActions.updateProgress({
              bookId,
              progress: fraction,
              ...(d?.label !== undefined ? { label: d.label } : {}),
              ...(d?.chapterIndex !== undefined ? { chapterIndex: d.chapterIndex } : {}),
              ...(d?.totalChapters !== undefined ? { totalChapters: d.totalChapters } : {}),
              ...(d?.estRemainingMs !== undefined ? { estRemainingMs: d.estRemainingMs } : {}),
            }),
          );
        },
```

Replace the running-chip render block (`if (phase === 'running') { ... }`):
```tsx
  if (phase === 'running') {
    const detailText = detail ? formatSubstageDetail(detail) : null;
    return (
      <div
        data-testid="detect-emotions-progress"
        className="shrink-0 inline-flex items-center gap-2 px-4 min-h-11 rounded-full border border-ink/15 text-sm"
      >
        <IconSpinner className="w-4 h-4 animate-spin text-magenta" />
        <span className="text-ink/70 max-w-[14rem] truncate">{status ?? 'Detecting…'}</span>
        {detailText && (
          <span
            data-testid="detect-emotions-progress-detail"
            className="text-ink/50 tabular-nums text-xs whitespace-nowrap"
          >
            {detailText}
          </span>
        )}
        <span className="tabular-nums text-ink/50">{Math.round(progress * 100)}%</span>
        <button
          type="button"
          onClick={() => abortRef.current?.abort()}
          className="text-xs text-ink/50 hover:text-magenta underline"
        >
          Cancel
        </button>
      </div>
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/detect-emotions-button.test.tsx`
Expected: PASS (all cases). Verified by inspection ahead of time: the pre-existing `'confirms, runs the pass...'` test's `opts.onPhase({ progress: 0.5, label: 'ch1' })` carries no `chapterIndex`/`estRemainingMs`, so `detail` there is just `{ label: 'ch1' }` and the conditional-spread dispatch adds nothing extra; the `'Cancel aborts...'` and `'clears the prosody stream...'` tests never call `onPhase` with those fields either, and the terminal-summary/error/throttle renders are driven by the untouched local `status`/`error`/`phase` state, not `detail`. None of the pre-existing tests read the second `onProgress` argument or assert on `estRemainingMs`.

- [ ] **Step 5: Commit**

```bash
git add src/components/detect-emotions-button.tsx src/components/detect-emotions-button.test.tsx
git commit -m "feat(frontend): show chapter count + ETA on the Detect-emotions inline chip"
```

---

## Task 14: Review-Script inline chip — `manuscript.tsx`

**Files:**
- Modify: `src/views/manuscript.tsx`
- Test: `src/views/manuscript.test.tsx`

**Interfaces:**
- Consumes: `scriptReview.activeStreams[bookId]` (Task 3), `formatSubstageDetail` (Task 1).

- [ ] **Step 1: Write the failing test**

Add to `src/views/manuscript.test.tsx`, in the same area as the other Review Script tests (near line 1106), using the same `configureStore` pattern as the neighboring test at lines 1137–1161:

```ts
  it('shows chapter count + ETA on the Review Script inline chip while a review runs', async () => {
    const user = userEvent.setup();
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        ui: uiSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        manuscript: {
          ...manuscriptSlice.getInitialState(),
          sentences: [liveSentence] as never,
        },
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'bk-1',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
      },
    });

    reviewScript.mockImplementation(
      async (
        _bookId: string,
        opts?: {
          onPhase?: (e: {
            progress: number;
            label?: string;
            chapterIndex?: number;
            totalChapters?: number;
            estRemainingMs?: number;
          }) => void;
        },
      ) => {
        opts?.onPhase?.({
          progress: 0.25,
          label: 'Reviewing script',
          chapterIndex: 3,
          totalChapters: 12,
          estRemainingMs: 125_000,
        });
        return new Promise(() => {}); // stays in-flight so the chip is on screen to assert on
      },
    );

    render(
      <Provider store={store}>
        <ManuscriptView
          characters={characters}
          chapters={[quarantineChapter]}
          currentChapterId={1}
          setCurrentChapterId={() => {}}
          sentencesFromStore={[liveSentence]}
        />
      </Provider>,
    );

    await user.click(screen.getByTestId('review-script-chapter'));

    await waitFor(() =>
      expect(screen.getByTestId('review-script-progress-detail').textContent).toBe(
        'Chapter 3 of 12 · ~2m left',
      ),
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/views/manuscript.test.tsx`
Expected: FAIL — `getByTestId('review-script-progress-detail')` does not exist yet (the chip does not exist)

- [ ] **Step 3: Write the implementation**

In `src/views/manuscript.tsx`:

Add the import (near the existing `formatSubstageDetail`-adjacent imports, e.g. after `import { selectAnalysisBusyForBook } from '../store/analysis-substage-selectors';`):
```ts
import { formatSubstageDetail } from '../lib/substage-progress-text';
```

Add the selector read (near the existing `analysisBusy` selector, around line 129):
```ts
  const reviewSubstage = useAppSelector((s) =>
    bookId ? s.scriptReview.activeStreams[bookId] : undefined,
  );
```

Insert a new chip immediately after the closing `</div>` of the `<div ref={reviewMenuRef} ...>` block (the Review Script button + menu-toggle wrapper), still inside the parent `<div className="flex flex-wrap items-center gap-2">` actions row:

```tsx
              {reviewSubstage && (
                <span
                  data-testid="review-script-progress"
                  className="shrink-0 inline-flex items-center gap-2 px-4 min-h-11 rounded-full border border-ink/15 text-sm"
                >
                  <IconSpinner className="w-4 h-4 animate-spin text-magenta" />
                  <span className="text-ink/70">{reviewSubstage.label}</span>
                  {formatSubstageDetail(reviewSubstage) && (
                    <span
                      data-testid="review-script-progress-detail"
                      className="text-xs text-ink/50 tabular-nums whitespace-nowrap"
                    >
                      {formatSubstageDetail(reviewSubstage)}
                    </span>
                  )}
                  <span className="tabular-nums text-ink/50">{reviewSubstage.progress}%</span>
                </span>
              )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/views/manuscript.test.tsx`
Expected: PASS (all cases, including the pre-existing Review Script tests)

- [ ] **Step 5: Commit**

```bash
git add src/views/manuscript.tsx src/views/manuscript.test.tsx
git commit -m "feat(frontend): add a Review-Script inline progress chip with chapter count + ETA"
```

---

## Task 15: e2e coverage

**Files:**
- Modify: `e2e/detect-emotions-pill-progress.spec.ts`

**Interfaces:**
- Consumes: `mockDetectEmotions` (Task 8), the `detect-emotions-progress-detail` chip (Task 13).

- [ ] **Step 1: Write the new assertion**

In `e2e/detect-emotions-pill-progress.spec.ts`, insert after the existing `await expect(pill).toContainText('Analysing', { timeout: 5_000 });` line and before the `/* Navigate to the Listen view ... */` comment:

```ts
    /* The inline running chip on the manuscript view itself shows the
       chapter-count detail once the mock's first phase tick lands
       (mockDetectEmotions ships chapterIndex/totalChapters from the start). */
    const detail = page.getByTestId('detect-emotions-progress-detail');
    await expect(detail).toContainText(/Chapter \d+ of \d+/, { timeout: 5_000 });
```

- [ ] **Step 2: Run the e2e spec**

Run: `npx playwright test e2e/detect-emotions-pill-progress.spec.ts --project=chromium`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add e2e/detect-emotions-pill-progress.spec.ts
git commit -m "test(e2e): assert the Detect-emotions chip shows chapter count during a run"
```

---

## Task 16: Full verification + regression docs

**Files:**
- Create: `docs/features/236-prosody-review-progress-detail.md` (from `docs/features/TEMPLATE.md`)
- Modify: `docs/features/INDEX.md`
- Modify: `docs/release-notes-next.md`
- Modify: `RELEASE_NOTES.md`

- [ ] **Step 1: Write the regression plan doc**

Create `docs/features/236-prosody-review-progress-detail.md` from `docs/features/TEMPLATE.md`, documenting: the `SubstageEntry` shape (Tasks 2–4), the server pacing contract (Tasks 5–7), the two-pass ETA reconciliation rule (Task 9), and the three render surfaces (Tasks 12–14). Link the design spec (`docs/superpowers/specs/2026-07-02-prosody-review-progress-detail-design.md`) and this plan. Set frontmatter `status: stable` once Task 17 confirms everything is green.

- [ ] **Step 2: Add the entry to `docs/features/INDEX.md`**

Add a row under the appropriate area heading pointing at the new plan doc.

- [ ] **Step 3: Append release-notes entries**

`docs/release-notes-next.md` — technical register entry describing the chapter-count + ETA addition, PR-refed once the PR number is known.

`RELEASE_NOTES.md` — user-facing, brand-voice line in the in-progress version section, e.g. "Detect emotions and Review Script now show which chapter they're on and roughly how long is left, instead of just a percentage."

- [ ] **Step 4: Run the full verify battery**

Run: `npm run verify`
Expected: PASS — typecheck, all unit/integration tests (frontend + server), e2e, and build all green.

- [ ] **Step 5: Commit**

```bash
git add docs/features/236-prosody-review-progress-detail.md docs/features/INDEX.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): add regression plan + release notes for progress-detail feature"
```

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- Data model (spec §Design 1) → Tasks 2, 3.
- Server pacing (spec §Design 2) → Tasks 5, 6, 7.
- Client plumbing (spec §Design 3) → Tasks 4, 8, 9, 10, 11.
- UI rendering (spec §Design 4) → Tasks 1, 12, 13, 14.
- Edge cases (spec §Design 5): chapter-failed timing → Tasks 5–7 (`finally`/post-loop bracketing); very short books → covered by Task 1's `totalChapters <= 1` guard and Task 7's single-chapter test; cross-tab → no code change needed (verified in the spec's "Current state", not re-tested here since `broadcast-middleware.test.ts` already covers whole-entry forwarding generically); reload mid-pass → no code change (unaffected, not re-tested).
- Testing section → every named test file has a corresponding task (Tasks 2–15).
- Out-of-scope items (top-bar pill, ASR content-QA, live countdown, script-review ETA accuracy) → none touched by any task.
- Adversarial-review outcomes 1–5 (two-pass reconciliation, mock layer, local-state retraction, layout/top-bar plumbing, chapter-failed bracketing) → Tasks 9, 8, 13, 11, 5–7 respectively. Outcome 6 (accepted limitation) → intentionally not addressed by any task.

**Placeholder scan** — no TBD/TODO; every step carries complete, runnable code or an exact command.

**Type consistency** — `SubstageEntry` (Tasks 2–3) is the single shape referenced by Task 4's selector, Task 9's `SubstageDetail` (a deliberately separate, narrower shape for the thunk callback — documented inline), Task 11's `StatusDetail.analysisSubstage`, and consumed identically by `formatSubstageDetail` (Task 1) in Tasks 12–14. Field names (`chapterIndex`, `totalChapters`, `estRemainingMs`) are identical across every layer, server to UI.

## Adversarial review outcomes (plan-level pass, Opus tier)

A second `assumption-checker` pass — this time against the plan itself, verified line-by-line against the real current source files — found:

1. **(Critical, fixed)** Task 13's test fed `estRemainingMs: 125_000` into the Detect-emotions button and asserted the chip shows the same value / `~2m left`. But the button runs the real `runProsodyPasses` (Task 9), whose reconciliation *doubles* the ETA during pass 1 (`own-remaining + (elapsed + own-remaining)`) — the actual value is ~250,000ms → `~4m left`. The test as originally written could never pass. Task 13's test and its Redux-entry assertion are rewritten with the correct (tolerance-based, since real elapsed time isn't fake-timer-controlled here) expectation.
2. **(Significant, fixed)** Task 6's stated replacement range (`131–218`) extended past the route's `finally` block into the terminal `result`/`res.end()` emission, which would delete it and hang the route on literal execution. Corrected to `131–213`, with an explicit note on what NOT to include.
3. **(Significant, fixed)** Task 7's stated range (`286–379`) stopped one line short of the actual `finally` block (`379` is the `for` loop's own closing brace; `380–382` is the `finally`), which would leave an orphaned `finally` — a syntax error. Corrected to `286–382`.
4. **(Minor, fixed)** Task 11's stated range for `top-bar.tsx` (`168–171`) included line 171, the `StatusDetail` interface's own closing brace, which would delete it. Corrected to `168–170`.
5. **(Confirmed, no change needed)** The reviewer independently re-derived Task 9's fake-timer-based ETA arithmetic by hand against all four of its test expectations and confirmed the math and `vi.useFakeTimers()`/`vi.setSystemTime()` semantics are sound; confirmed Vitest's `toEqual` genuinely ignores `undefined`-valued properties (so Task 4's "no edit needed to pre-existing tests" claim holds); confirmed Task 6's `instruct-annotation.test.ts` fixture/type assumptions are accurate; confirmed Task 11's "StatusInput never needs widening" claim against `summarizeStatus`'s actual body; confirmed no task has a forward reference to a later task's export. None of these needed a fix.
6. **(Noted, not a defect)** The reviewer flagged that the always-visible Detect-emotions chip will show the doubled (larger) ETA throughout all of pass 1, which could read as alarming rather than reassuring. This is the deliberate, spec-documented behavior of Decision 5 (the design spec's own §4 copy example anticipates exactly this: "ETA reflects the full projected pass-2 duration per Decision 5, not 'almost done.'") — not a new gap, just correctly surfaced now that Task 13's test reflects it accurately instead of masking it with a wrong expected value.

---

Plan complete and saved to `docs/superpowers/plans/2026-07-02-prosody-review-progress-detail.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
