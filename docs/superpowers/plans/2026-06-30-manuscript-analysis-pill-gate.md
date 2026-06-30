# Manuscript analysis pill + Generate-gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface live progress of the two manuscript analysis sub-stages (Detect emotions, Review Script) inside the Status pill, hard-disable Generate per-book while either runs, make the two passes mutually exclusive per book, and guard the fs-65 auto-trigger against double-firing — with the progress synced cross-tab.

**Architecture:** Two transient Redux slices (`prosody`, `scriptReview`) hold per-book progress in a `Record<bookId, SubstageEntry>` map. A new `sync:substage` `BroadcastChannel` message keeps those maps consistent across tabs. `summarizeStatus` gains an "analysis sub-stage" rung; the standalone prosody pill is retired. Generate and both analysis buttons gate on a shared `selectAnalysisBusyForBook` selector.

**Tech Stack:** Vite + React 18 + TypeScript + Redux Toolkit (Immer), Vitest + React Testing Library (jsdom), Playwright (chromium, mock mode).

**Source spec:** `docs/superpowers/specs/2026-06-30-manuscript-analysis-pill-gate-design.md` (two adversarial review rounds; 14 findings resolved).

## Global Constraints

- **Design tokens only** — no hex literals in component code; use the CSS custom properties / Tailwind tokens already in use (`--peach`, `--magenta`, `--ink`, etc.).
- **OpenAPI is the type source of truth** — do not hand-write `Chapter`/`QueueEntry`/etc.; import from `src/lib/api-types.ts`.
- **RTK Immer** — slice reducers mutate drafts; do not rewrite to spreads.
- **UI copy never says "prosody"** — user-facing strings are "Detecting emotions" / "Reviewing".
- **Branch:** all work lands on `docs/docs-manuscript-analysis-pill-gate` is the spec branch; cut a fresh `feat/frontend-analysis-pill-gate` off latest `main` for the implementation (per CONTRIBUTING branching workflow).
- **Commit convention:** `<type>(<scope>): <subject>` — scope `frontend` for app code.
- **Verify before declaring done:** `npm run verify` (typecheck + all tests + e2e + build).
- **`SubstageEntry.progress` is a 0..100 integer**; `setActive`/`updateProgress` accept a 0..1 fraction and round it (preserves the current `prosody-slice` contract so call sites don't change their math).

---

### Task 1: Migrate `prosody-slice` to a per-book map (+ external reducers)

**Files:**
- Modify: `src/store/prosody-slice.ts` (full rewrite of the slice body)
- Modify: `src/components/layout.tsx:163` (the `prosodyStream` selector read), `layout.tsx:1044/1048/1050/1057` (auto-trigger dispatches), `layout.tsx:1356-1362` (the `prosodyPill` derivation)
- Test: `src/store/prosody-slice.test.ts` (rewrite for the map shape), `src/components/layout-prosody-pill.test.tsx` (migrate to the map shape so this commit stays green — Task 3 deletes it when the pill is retired)

> **Green-between-commits note:** `layout-prosody-pill.test.tsx` preloads the singular `{ activeStream }` and calls `prosodyActions.clear()` with no argument. After this migration both break (`clear()` is a typecheck error; the preload no longer renders the pill), and the pre-commit gate runs the frontend suite for a frontend change — so this test MUST be migrated in the same commit (Step 5 below), not deferred to Task 3. (`prosody-autotrigger.test.tsx` mocks `runProsodyPasses` and never reads `activeStream`/`clear()`, so it is unaffected.) Task 3 deletes this test when the pill is retired — the brief migrate-then-delete (finding R4) is deliberate: it keeps every commit green and avoids any window where prosody progress goes invisible.

**Interfaces:**
- Produces:
  - `interface SubstageEntry { progress: number; label: string }`
  - `interface ProsodyState { activeStreams: Record<string, SubstageEntry> }`
  - `prosodyActions.setActive({ bookId: string; progress: number; label: string })` (progress is a 0..1 fraction, stored as `Math.round(progress*100)`)
  - `prosodyActions.updateProgress({ bookId: string; progress: number })`
  - `prosodyActions.clear({ bookId: string })`
  - `prosodyActions.applyExternalSet({ bookId: string; entry: SubstageEntry })`
  - `prosodyActions.applyExternalClear({ bookId: string })`

- [ ] **Step 1: Rewrite the slice test for the map shape**

Replace the contents of `src/store/prosody-slice.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { prosodySlice, prosodyActions, type SubstageEntry } from './prosody-slice';

const reduce = (actions: { type: string; payload?: unknown }[]) =>
  actions.reduce((s, a) => prosodySlice.reducer(s, a), prosodySlice.getInitialState());

describe('prosody-slice (per-book map)', () => {
  it('setActive stores a rounded-percent entry keyed by bookId', () => {
    const s = reduce([prosodyActions.setActive({ bookId: 'b1', progress: 0.5, label: 'Detecting emotions' })]);
    expect(s.activeStreams.b1).toEqual<SubstageEntry>({ progress: 50, label: 'Detecting emotions' });
  });

  it('updateProgress only touches the named book', () => {
    const s = reduce([
      prosodyActions.setActive({ bookId: 'b1', progress: 0, label: 'Detecting emotions' }),
      prosodyActions.setActive({ bookId: 'b2', progress: 0, label: 'Detecting emotions' }),
      prosodyActions.updateProgress({ bookId: 'b1', progress: 0.42 }),
    ]);
    expect(s.activeStreams.b1.progress).toBe(42);
    expect(s.activeStreams.b2.progress).toBe(0);
  });

  it('clear removes only the named book, leaving others intact', () => {
    const s = reduce([
      prosodyActions.setActive({ bookId: 'b1', progress: 0, label: 'x' }),
      prosodyActions.setActive({ bookId: 'b2', progress: 0, label: 'y' }),
      prosodyActions.clear({ bookId: 'b1' }),
    ]);
    expect(s.activeStreams.b1).toBeUndefined();
    expect(s.activeStreams.b2).toBeDefined();
  });

  it('applyExternalSet / applyExternalClear touch only the named key', () => {
    const s1 = reduce([prosodyActions.applyExternalSet({ bookId: 'b9', entry: { progress: 30, label: 'Detecting emotions' } })]);
    expect(s1.activeStreams.b9).toEqual({ progress: 30, label: 'Detecting emotions' });
    const s2 = prosodySlice.reducer(s1, prosodyActions.applyExternalClear({ bookId: 'b9' }));
    expect(s2.activeStreams.b9).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/store/prosody-slice.test.ts`
Expected: FAIL — `activeStreams` undefined / `setActive` payload shape mismatch.

- [ ] **Step 3: Rewrite the slice**

Replace `src/store/prosody-slice.ts` with:

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
}

export interface ProsodyState {
  activeStreams: Record<string, SubstageEntry>;
}

const initialState: ProsodyState = { activeStreams: {} };

export const prosodySlice = createSlice({
  name: 'prosody',
  initialState,
  reducers: {
    setActive: (s, a: PayloadAction<{ bookId: string; progress: number; label: string }>) => {
      s.activeStreams[a.payload.bookId] = {
        progress: Math.round(a.payload.progress * 100),
        label: a.payload.label,
      };
    },
    updateProgress: (s, a: PayloadAction<{ bookId: string; progress: number }>) => {
      const e = s.activeStreams[a.payload.bookId];
      if (e) e.progress = Math.round(a.payload.progress * 100);
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

- [ ] **Step 4: Update the three `layout.tsx` consumers so the app still compiles & the standalone pill still works (it's retired in Task 3)**

In `src/components/layout.tsx`, change the selector at line 163:

```ts
// was: const prosodyStream = useAppSelector((s) => s.prosody.activeStream);
const prosodyStreams = useAppSelectorShallow((s) => s.prosody.activeStreams);
```

Change the `prosodyPill` derivation (lines 1356-1362) to read the first active entry from the map:

```ts
/* Phase 3 prosody-progress pill — first active per-book entry. Retired in a
   later task once the Status-pill rung lands; kept working here so this task
   leaves the tree green. */
const prosodyPill: { label: string; percent: number } | null = (() => {
  const first = Object.values(prosodyStreams)[0];
  return first ? { label: first.label, percent: first.progress } : null;
})();
```

Change the auto-trigger dispatches (lines 1044/1050/1057) to the keyed `clear` and a user-facing label:

```ts
dispatch(prosodyActions.setActive({ bookId: id, progress: 0, label: 'Detecting emotions' }));
// ...
dispatch(prosodyActions.clear({ bookId: id }));   // success path (was clear())
// ...
if (pillActive) dispatch(prosodyActions.clear({ bookId: id }));  // catch path (was clear())
```

(`useAppSelectorShallow` is already imported in `layout.tsx` — see line 161.)

- [ ] **Step 5: Migrate `layout-prosody-pill.test.tsx` to the map shape (keeps the commit green)**

In `src/components/layout-prosody-pill.test.tsx`, change the store factory's preloaded state from the singular `activeStream` to the `activeStreams` map, and every `prosodyActions.clear()` call to `prosodyActions.clear({ bookId: 'b1' })`:

```ts
// store factory: preload the map, not the singular field
function makeStore(prosodyState?: Partial<ReturnType<typeof prosodySlice.getInitialState>>) {
  // ...reducer map unchanged...
  return configureStore({
    reducer: { /* ...unchanged... */ prosody: prosodySlice.reducer },
    preloadedState: prosodyState ? { prosody: prosodyState as ReturnType<typeof prosodySlice.getInitialState> } : undefined,
  });
}

// test 1 — pill renders:
const store = makeStore({ activeStreams: { b1: { progress: 42, label: 'Detecting emotions' } } });
// assert pill text contains 'Detecting emotions' and '42%'

// test 2 — absent when empty:
const store = makeStore({ activeStreams: {} });

// test 3 — updates with store changes:
store.dispatch(prosodyActions.setActive({ bookId: 'b1', progress: 0, label: 'Detecting emotions' }));
store.dispatch(prosodyActions.updateProgress({ bookId: 'b1', progress: 0.77 }));
store.dispatch(prosodyActions.clear({ bookId: 'b1' }));   // was clear()
```

(The pill text assertion changes from `'Phase 3 — Detecting prosody'` to `'Detecting emotions'` because the labels are now user-facing.)

- [ ] **Step 6: Run the slice test + the pill test + typecheck**

Run: `npm run test -- src/store/prosody-slice.test.ts src/components/layout-prosody-pill.test.tsx && npm run typecheck`
Expected: both tests PASS; typecheck PASS.

- [ ] **Step 7: Commit**

```bash
git add src/store/prosody-slice.ts src/store/prosody-slice.test.ts src/components/layout.tsx src/components/layout-prosody-pill.test.tsx
git commit -m "refactor(frontend): migrate prosody-slice to per-book activeStreams map"
```

---

### Task 2: Add the `activeStreams` map to `script-review-slice`

**Files:**
- Modify: `src/store/script-review-slice.ts`
- Test: `src/store/script-review-slice.test.ts`

**Interfaces:**
- Consumes: `SubstageEntry` from `./prosody-slice` (Task 1).
- Produces (on `scriptReviewActions`): `setActive`, `updateProgress`, `clear`, `applyExternalSet`, `applyExternalClear` — same payload shapes as the prosody equivalents. New state field `activeStreams: Record<string, SubstageEntry>`.

- [ ] **Step 1: Add failing tests**

Append to `src/store/script-review-slice.test.ts`:

```ts
import { SubstageEntry } from './prosody-slice';

describe('script-review-slice activeStreams', () => {
  const reduceR = (actions: { type: string; payload?: unknown }[]) =>
    actions.reduce((s, a) => scriptReviewSlice.reducer(s, a), scriptReviewSlice.getInitialState());

  it('setActive/updateProgress/clear are per-book', () => {
    const s = reduceR([
      scriptReviewActions.setActive({ bookId: 'b1', progress: 0, label: 'Reviewing' }),
      scriptReviewActions.setActive({ bookId: 'b2', progress: 0, label: 'Reviewing' }),
      scriptReviewActions.updateProgress({ bookId: 'b1', progress: 0.6 }),
      scriptReviewActions.clear({ bookId: 'b2' }),
    ]);
    expect(s.activeStreams.b1).toEqual<SubstageEntry>({ progress: 60, label: 'Reviewing' });
    expect(s.activeStreams.b2).toBeUndefined();
  });

  it('applyExternalSet/applyExternalClear touch only the named key', () => {
    const s1 = reduceR([scriptReviewActions.applyExternalSet({ bookId: 'bX', entry: { progress: 10, label: 'Reviewing' } })]);
    expect(s1.activeStreams.bX).toEqual({ progress: 10, label: 'Reviewing' });
    const s2 = scriptReviewSlice.reducer(s1, scriptReviewActions.applyExternalClear({ bookId: 'bX' }));
    expect(s2.activeStreams.bX).toBeUndefined();
  });
});
```

(Ensure `scriptReviewSlice` and `scriptReviewActions` are imported at the top of the test file — they already are for the existing `byBook` tests.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/store/script-review-slice.test.ts`
Expected: FAIL — `setActive` / `activeStreams` don't exist.

- [ ] **Step 3: Implement**

In `src/store/script-review-slice.ts`:

Add the import and extend the state interface + initial state:

```ts
import type { SubstageEntry } from './prosody-slice';
```

```ts
export interface ScriptReviewState {
  byBook: Record<string, ScriptReviewBucket | undefined>;
  activeStreams: Record<string, SubstageEntry>;
}

const initialState: ScriptReviewState = {
  byBook: {},
  activeStreams: {},
};
```

Add these reducers inside the existing `reducers: { ... }` object (alongside `setReview`/`toggleOp`/...):

```ts
    setActive: (s, a: PayloadAction<{ bookId: string; progress: number; label: string }>) => {
      s.activeStreams[a.payload.bookId] = {
        progress: Math.round(a.payload.progress * 100),
        label: a.payload.label,
      };
    },
    updateProgress: (s, a: PayloadAction<{ bookId: string; progress: number }>) => {
      const e = s.activeStreams[a.payload.bookId];
      if (e) e.progress = Math.round(a.payload.progress * 100);
    },
    clear: (s, a: PayloadAction<{ bookId: string }>) => {
      delete s.activeStreams[a.payload.bookId];
    },
    applyExternalSet: (s, a: PayloadAction<{ bookId: string; entry: SubstageEntry }>) => {
      s.activeStreams[a.payload.bookId] = a.payload.entry;
    },
    applyExternalClear: (s, a: PayloadAction<{ bookId: string }>) => {
      delete s.activeStreams[a.payload.bookId];
    },
```

Update the slice header comment's "non-broadcast" note to: "the activeStreams progress map IS broadcast cross-tab via sync:substage; byBook results stay tab-local."

(Finding R5: if any existing test asserts `scriptReviewSlice.getInitialState()` deep-equals `{ byBook: {} }`, widen it to include `activeStreams: {}` — grep `getInitialState` in `script-review-slice.test.ts` before running.)

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -- src/store/script-review-slice.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/script-review-slice.ts src/store/script-review-slice.test.ts
git commit -m "feat(frontend): add per-book activeStreams progress map to script-review-slice"
```

---

### Task 3: Selectors + `summarizeStatus` rung + retire the standalone pill

**Files:**
- Create: `src/store/analysis-substage-selectors.ts`
- Modify: `src/components/top-bar.tsx` (`StatusInput`, `summarizeStatus`, `StatusDetail`)
- Modify: `src/components/layout.tsx` (compute `analysisSubstage`, pass to `summarizeStatus` + `statusDetail`; delete the `prosodyPill` derivation + its JSX block)
- Modify: `src/components/status-popover.tsx` (render the sub-stage row)
- Delete: `src/components/layout-prosody-pill.test.tsx`
- Modify: `e2e/analysis-prosody-toggle.spec.ts` (re-point off `prosody-pill`)
- Test: `src/store/analysis-substage-selectors.test.ts`, `src/components/top-bar.test.tsx`

**Interfaces:**
- Consumes: `prosody.activeStreams`, `scriptReview.activeStreams` (Tasks 1-2).
- Produces:
  - `selectProsodyRunningForBook(state, bookId): boolean`
  - `selectReviewRunningForBook(state, bookId): boolean`
  - `selectAnalysisBusyForBook(state, bookId): boolean`
  - `analysisBusyMessage(state, bookId): string | null` (per-pass "Generate blocked" copy)
  - `selectAnalysisSubstage(state): { kind: 'prosody' | 'review'; label: string; percent: number } | null` (memoized)
  - `StatusInput` gains optional `analysisSubstage?: { kind: 'prosody' | 'review'; percent: number } | null`; `StatusDetail` gains optional `analysisSubstage?: { label: string; percent: number } | null`.

- [ ] **Step 1: Write the selector test**

Create `src/store/analysis-substage-selectors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  selectProsodyRunningForBook,
  selectReviewRunningForBook,
  selectAnalysisBusyForBook,
  selectAnalysisSubstage,
} from './analysis-substage-selectors';
import type { RootState } from './index';

const mk = (prosody: Record<string, { progress: number; label: string }>, review: Record<string, { progress: number; label: string }>) =>
  ({ prosody: { activeStreams: prosody }, scriptReview: { activeStreams: review } } as unknown as RootState);

describe('analysis-substage selectors', () => {
  it('per-book running flags', () => {
    const s = mk({ b1: { progress: 10, label: 'Detecting emotions' } }, { b2: { progress: 5, label: 'Reviewing' } });
    expect(selectProsodyRunningForBook(s, 'b1')).toBe(true);
    expect(selectProsodyRunningForBook(s, 'b2')).toBe(false);
    expect(selectReviewRunningForBook(s, 'b2')).toBe(true);
    expect(selectAnalysisBusyForBook(s, 'b1')).toBe(true);
    expect(selectAnalysisBusyForBook(s, 'b2')).toBe(true);
    expect(selectAnalysisBusyForBook(s, 'b3')).toBe(false);
  });

  it('selectAnalysisSubstage prefers prosody, then lowest bookId', () => {
    const s = mk(
      { b2: { progress: 40, label: 'Detecting emotions' }, b1: { progress: 70, label: 'Detecting emotions' } },
      { b9: { progress: 5, label: 'Reviewing' } },
    );
    expect(selectAnalysisSubstage(s)).toEqual({ kind: 'prosody', label: 'Detecting emotions', percent: 70 });
  });

  it('falls back to review when no prosody runs; null when idle', () => {
    expect(selectAnalysisSubstage(mk({}, { b5: { progress: 12, label: 'Reviewing' } }))).toEqual({
      kind: 'review',
      label: 'Reviewing',
      percent: 12,
    });
    expect(selectAnalysisSubstage(mk({}, {}))).toBeNull();
  });

  it('selectAnalysisSubstage returns a stable reference for unchanged input (memoized)', () => {
    const s = mk({ b1: { progress: 40, label: 'Detecting emotions' } }, {});
    expect(selectAnalysisSubstage(s)).toBe(selectAnalysisSubstage(s));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/store/analysis-substage-selectors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the selectors**

Create `src/store/analysis-substage-selectors.ts`:

```ts
import { createSelector } from '@reduxjs/toolkit';
import type { RootState } from './index';
import type { SubstageEntry } from './prosody-slice';

export const selectProsodyRunningForBook = (state: RootState, bookId: string): boolean =>
  bookId in state.prosody.activeStreams;

export const selectReviewRunningForBook = (state: RootState, bookId: string): boolean =>
  bookId in state.scriptReview.activeStreams;

export const selectAnalysisBusyForBook = (state: RootState, bookId: string): boolean =>
  selectProsodyRunningForBook(state, bookId) || selectReviewRunningForBook(state, bookId);

/** User-facing "why is Generate blocked" copy for a busy book — per-pass
    wording (spec copy). Returns null when the book isn't busy. */
export const analysisBusyMessage = (state: RootState, bookId: string): string | null => {
  if (selectProsodyRunningForBook(state, bookId)) return 'Wait — emotions are still being detected';
  if (selectReviewRunningForBook(state, bookId)) return 'Wait — script review is in progress';
  return null;
};

const firstByLowestBookId = (m: Record<string, SubstageEntry>): { bookId: string; entry: SubstageEntry } | null => {
  const ids = Object.keys(m).sort();
  return ids.length ? { bookId: ids[0], entry: m[ids[0]] } : null;
};

/** Memoized so an unchanged map returns a stable reference (avoids the
    "selector returned a different result" re-render churn). Prefers a prosody
    pass over a review pass; ties broken by lowest bookId. */
export const selectAnalysisSubstage = createSelector(
  [(s: RootState) => s.prosody.activeStreams, (s: RootState) => s.scriptReview.activeStreams],
  (prosody, review): { kind: 'prosody' | 'review'; label: string; percent: number } | null => {
    const p = firstByLowestBookId(prosody);
    if (p) return { kind: 'prosody', label: p.entry.label, percent: p.entry.progress };
    const r = firstByLowestBookId(review);
    if (r) return { kind: 'review', label: r.entry.label, percent: r.entry.progress };
    return null;
  },
);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -- src/store/analysis-substage-selectors.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `summarizeStatus` rung test**

In `src/components/top-bar.test.tsx`, inside the existing `summarizeStatus` describe block, add:

```ts
it('shows an Analysing rung for an active analysis sub-stage (below real analysis)', () => {
  const base = { analysis: null, generation: null, design: null, pendingRevisionsCount: 0, anyModelLoading: false };
  expect(summarizeStatus({ ...base, analysisSubstage: { kind: 'prosody', percent: 40 } })).toMatchObject({
    label: 'Analysing',
    detail: '40%',
    icon: 'spinner',
  });
  // Real analysis still outranks a sub-stage.
  expect(
    summarizeStatus({
      ...base,
      analysis: { state: 'running', percent: 12, kind: 'full' } as never,
      analysisSubstage: { kind: 'review', percent: 90 },
    }),
  ).toMatchObject({ detail: '12%' });
});
```

(No need to touch the other `summarizeStatus` calls in this file — the field is optional.)

- [ ] **Step 6: Run to verify it fails**

Run: `npm run test -- top-bar.test.tsx`
Expected: FAIL — `analysisSubstage` not a valid `StatusInput` field.

- [ ] **Step 7: Implement the rung**

In `src/components/top-bar.tsx`, add to the `StatusInput` interface (after `anyModelLoading`). **Declare it optional** (`?`) so the dozens of existing `summarizeStatus` calls in `top-bar.test.tsx` don't all need a new field — the `if (analysisSubstage)` guard treats `undefined` and `null` identically:

```ts
  /** The active analysis sub-stage (prosody/review) progress, or null/absent.
      Folds into the "Analysing" rung below the primary analysis pass. */
  analysisSubstage?: { kind: 'prosody' | 'review'; percent: number } | null;
```

Add `analysisSubstage` to the destructured params of `summarizeStatus` (`analysisSubstage = null` as the default), and insert the rung **directly after** the `analysis?.state === 'running'` block (and before `design?.state === 'running'`):

```ts
  if (analysisSubstage)
    return { label: 'Analysing', tone: 'peach', icon: 'spinner', detail: `${analysisSubstage.percent}%` };
```

Add `analysisSubstage` to the `StatusDetail` interface too — **carrying the `label`** (the popover renders it, so the selector's `label` field is not dead):

```ts
  analysisSubstage?: { label: string; percent: number } | null;
```

- [ ] **Step 8: Wire Layout, render the popover row, and retire the standalone pill**

In `src/components/layout.tsx`:

Add the selector read near the other status selectors (after line 163):

```ts
const analysisSubstage = useAppSelector(selectAnalysisSubstage);
```

(Import it: `import { selectAnalysisSubstage } from '../store/analysis-substage-selectors';`)

Pass it into both `summarizeStatus` and `statusDetail`:

```ts
  const statusSummary = showStatus
    ? summarizeStatus({
        analysis: analysisPill,
        generation: generationPill,
        design: designPill,
        pendingRevisionsCount: pending.length,
        anyModelLoading,
        analysisSubstage: analysisSubstage ? { kind: analysisSubstage.kind, percent: analysisSubstage.percent } : null,
      })
    : null;
```

Add `analysisSubstage: analysisSubstage ? { label: analysisSubstage.label, percent: analysisSubstage.percent } : null,` to the `statusDetail` object literal (line 1429+).

Also update `showStatus` so the pill appears when a sub-stage is the only activity:

```ts
  const showStatus =
    showTtsControls ||
    analysisPill !== null ||
    generationPill !== null ||
    designPill !== null ||
    analysisSubstage !== null ||
    pending.length > 0;
```

Delete the `prosodyPill` derivation (the lines 1356-1362 block you edited in Task 1) AND the `{prosodyPill && ( ... )}` JSX block at lines 1515-1525. Remove the now-unused `prosodyStreams` selector from line 163 if nothing else uses it (the popover reads the substage selector instead).

In `src/components/status-popover.tsx`, render a sub-stage row inside the analysis section when `detail.analysisSubstage` is set:

```tsx
{detail.analysisSubstage && (
  <div data-testid="substage-row" className="flex items-center justify-between text-sm text-ink/70">
    <span>{detail.analysisSubstage.label}</span>
    <span className="tabular-nums">{detail.analysisSubstage.percent}%</span>
  </div>
)}
```

(Place it adjacent to the existing `AnalysisPill` render in the analysis section. The `label` is the user-facing phase text the dispatch sites set — "Detecting emotions" / "Reviewing".)

- [ ] **Step 9: Delete the standalone-pill unit test and re-point the e2e**

Delete `src/components/layout-prosody-pill.test.tsx`.

In `e2e/analysis-prosody-toggle.spec.ts`, replace any `getByTestId('prosody-pill')` assertion with the Status-pill path. Read the spec first; the substage now surfaces on the top-bar Status pill (`getByTestId('status-pill')`, label "Analysing") and its popover row (`getByTestId('substage-row')`). If the spec only asserted the toggle (enable/disable prosody) and used the pill as a progress proxy, assert on `substage-row` after opening the Status popover instead.

- [ ] **Step 10: Run the affected tests + typecheck**

Run: `npm run test -- top-bar.test.tsx src/store/analysis-substage-selectors.test.ts && npm run typecheck`
Expected: PASS. (Confirm `layout-prosody-pill.test.tsx` is gone, not failing.)

- [ ] **Step 11: Commit**

```bash
git add src/store/analysis-substage-selectors.ts src/store/analysis-substage-selectors.test.ts src/components/top-bar.tsx src/components/top-bar.test.tsx src/components/layout.tsx src/components/status-popover.tsx e2e/analysis-prosody-toggle.spec.ts
git rm src/components/layout-prosody-pill.test.tsx
git commit -m "feat(frontend): fold analysis sub-stage progress into the Status pill"
```

---

### Task 4: Manual `DetectEmotionsButton` drives the slice (clear in `finally`)

**Files:**
- Modify: `src/components/detect-emotions-button.tsx`
- Test: `src/components/detect-emotions-button.test.tsx`

**Interfaces:**
- Consumes: `prosodyActions.setActive/updateProgress/clear` (Task 1); `runProsodyPasses` (existing).

- [ ] **Step 1: Add a failing test**

In `src/components/detect-emotions-button.test.tsx`, the existing `makeStore()` only wires `manuscript`/`ui`/`chapters`. **Add the `prosody` and `scriptReview` reducers to it** (needed here and by Task 6), and add this test. The component clicks `detect-emotions-button` → `detect-emotions-confirm` → `run()` (testids confirmed in the component at lines 101/146).

Extend `makeStore()`:

```ts
import { prosodySlice } from '../store/prosody-slice';
import { scriptReviewSlice } from '../store/script-review-slice';
// in configureStore.reducer add:  prosody: prosodySlice.reducer, scriptReview: scriptReviewSlice.reducer,
```

Add a mock for the thunk and the test (place the mock near the existing `../lib/api` mock):

```ts
import { runProsodyPasses } from '../store/prosody-thunk';
vi.mock('../store/prosody-thunk', () => ({ runProsodyPasses: vi.fn() }));

it('sets the prosody stream during a run and clears it in finally even on throw', async () => {
  let streamWhileRunning: unknown;
  vi.mocked(runProsodyPasses).mockImplementation(async (bookId: string, opts: { onProgress?: (f: number) => void }) => {
    opts.onProgress?.(0.5);
    streamWhileRunning = store.getState().prosody.activeStreams[bookId]; // captured mid-run
    throw new Error('boom'); // exercise the error path
  });
  const store = makeStore();
  render(
    <Provider store={store}>
      <DetectEmotionsButton />
    </Provider>,
  );
  fireEvent.click(screen.getByTestId('detect-emotions-button'));
  fireEvent.click(screen.getByTestId('detect-emotions-confirm'));
  await waitFor(() => expect(runProsodyPasses).toHaveBeenCalled());
  // set while running:
  expect(streamWhileRunning).toMatchObject({ label: 'Detecting emotions' });
  // cleared in finally despite the throw:
  await waitFor(() => expect(store.getState().prosody.activeStreams.b1).toBeUndefined());
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- detect-emotions-button.test.tsx`
Expected: FAIL — stream never set / not cleared on throw.

- [ ] **Step 3: Implement**

In `src/components/detect-emotions-button.tsx`, rewrite the `run` body so the pill is driven from the slice and cleared in `finally`:

```ts
  const run = async () => {
    if (!bookId) return;
    setPhase('running');
    setProgress(0);
    setError(null);
    setStatus('Starting…');
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch(prosodyActions.setActive({ bookId, progress: 0, label: 'Detecting emotions' }));
    try {
      const { totalAnnotations, totalChapters } = await runProsodyPasses(bookId, {
        dispatch,
        signal: controller.signal,
        onProgress: (fraction) => {
          setProgress(fraction);
          dispatch(prosodyActions.updateProgress({ bookId, progress: fraction }));
        },
        onStatus: (label) => setStatus(label),
        onThrottle: () => setStatus('Waiting on the analyzer rate limit…'),
      });
      setStatus(
        `Tagged ${totalAnnotations} line${totalAnnotations === 1 ? '' : 's'} across ` +
          `${totalChapters} chapter${totalChapters === 1 ? '' : 's'}.`,
      );
      setPhase('idle');
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        setStatus(null);
        setPhase('idle');
      } else if (e instanceof DetectEmotionsError && e.code === 'no_attribution') {
        setError('Run analysis first — there are no attributed lines to tag.');
        setPhase('idle');
      } else if (e instanceof DetectInstructError) {
        setError(e.message);
        setPhase('idle');
      } else {
        setError((e as Error).message);
        setPhase('idle');
      }
    } finally {
      dispatch(prosodyActions.clear({ bookId }));
      abortRef.current = null;
    }
  };
```

Add the import: `import { prosodyActions } from '../store/prosody-slice';`

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -- detect-emotions-button.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/detect-emotions-button.tsx src/components/detect-emotions-button.test.tsx
git commit -m "feat(frontend): drive the prosody pill from DetectEmotionsButton, clear in finally"
```

---

### Task 5: `runReviewScript` thunk (clear in `finally`) + delegate `handleReviewScript`

**Files:**
- Create: `src/store/script-review-thunk.ts`
- Modify: `src/views/manuscript.tsx` (`handleReviewScript` delegates to the thunk)
- Test: `src/store/script-review-thunk.test.ts`

**Interfaces:**
- Consumes: `scriptReviewActions.setActive/updateProgress/clear/setReview`, `api.reviewScript`, `planApply`, `notificationsActions`.
- Produces: `runReviewScript(bookId, { dispatch, wholeBook, chapterId?, model, sentences, characterIds }): Promise<void>` — a plain async function (matches `runProsodyPasses`' shape: takes `dispatch` in its options bag, not a thunk-creator). **Progress comes from `api.reviewScript`'s `onPhase` callback** (verified `api.ts:2942` — `onPhase?: (e: { progress: number; label?; chapterId? }) => void`; the server streams real 0..1 progress via `phase` events). Do **not** count `onOps` for progress — `onOps` fires only for chapters that *have* ops, so a book with empty chapters would stall the pill below 100%.

- [ ] **Step 1: Write the failing test**

Create `src/store/script-review-thunk.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const reviewScript = vi.fn();
vi.mock('../lib/api', () => ({ api: { reviewScript: (...a: unknown[]) => reviewScript(...a) } }));
vi.mock('../lib/script-review-apply', () => ({
  planApply: () => ({ appliable: [], unappliable: [] }),
}));

import { runReviewScript } from './script-review-thunk';
import { scriptReviewActions } from './script-review-slice';

describe('runReviewScript', () => {
  beforeEach(() => reviewScript.mockReset());

  it('sets active, forwards onPhase progress, then clears in finally on success', async () => {
    reviewScript.mockImplementation(async (_bookId: string, opts: { onPhase?: (e: { progress: number }) => void }) => {
      opts.onPhase?.({ progress: 0.5 });
      opts.onPhase?.({ progress: 1 });
    });
    const dispatch = vi.fn();
    await runReviewScript('b1', { dispatch, wholeBook: true, model: 'gemma', sentences: [], characterIds: new Set<number>() });
    const types = dispatch.mock.calls.map((c) => c[0].type);
    expect(types).toContain(scriptReviewActions.setActive.type);
    expect(types).toContain(scriptReviewActions.updateProgress.type); // fired from onPhase
    const lastProg = dispatch.mock.calls.map((c) => c[0]).filter((a) => a.type === scriptReviewActions.updateProgress.type).pop();
    expect(lastProg.payload).toEqual({ bookId: 'b1', progress: 1 });
    expect(types[types.length - 1]).toBe(scriptReviewActions.clear.type);
  });

  it('clears in finally even when the API throws', async () => {
    reviewScript.mockRejectedValue(new Error('boom'));
    const dispatch = vi.fn();
    await runReviewScript('b1', { dispatch, wholeBook: true, model: 'gemma', sentences: [], characterIds: new Set<number>() });
    const types = dispatch.mock.calls.map((c) => c[0].type);
    expect(types[types.length - 1]).toBe(scriptReviewActions.clear.type);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/store/script-review-thunk.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the thunk**

Create `src/store/script-review-thunk.ts`. Lift the body of `handleReviewScript` (`manuscript.tsx:697-758`) into a reusable function, adding the `setActive`/`updateProgress`/`clear({bookId})` dispatches with `clear` in `finally`:

```ts
import type { AppDispatch } from './index';
import { api } from '../lib/api';
import { planApply, type ReviewOp } from '../lib/script-review-apply';
import { scriptReviewActions, type ReviewOpWithChapter } from './script-review-slice';
import { notificationsActions } from './notifications-slice';

export interface ReviewLiveSentence {
  id: number;
  chapterId: number;
  text: string;
  characterId: number | null;
  instruct?: string;
  vocalization?: string;
}

export interface RunReviewScriptOpts {
  dispatch: AppDispatch;
  wholeBook: boolean;
  chapterId?: number;
  model: string;
  /** Live sentences for index-mapped planApply (caller passes sentencesRef.current). */
  sentences: ReviewLiveSentence[];
  characterIds: Set<number>;
}

export async function runReviewScript(bookId: string, opts: RunReviewScriptOpts): Promise<void> {
  const { dispatch, wholeBook, chapterId, model, sentences, characterIds } = opts;
  const allOps: ReviewOpWithChapter[] = [];
  const failed: Array<{ chapterId: number; message: string }> = [];
  dispatch(scriptReviewActions.setActive({ bookId, progress: 0, label: 'Reviewing' }));
  try {
    await api.reviewScript(bookId, {
      ...(wholeBook ? {} : { chapterId }),
      model,
      onPhase: ({ progress }: { progress: number }) =>
        dispatch(scriptReviewActions.updateProgress({ bookId, progress })),
      onOps: ({ chapterId: chId, ops }: { chapterId: number; ops: ReviewOp[] }) => {
        for (const op of ops) allOps.push({ ...op, chapterId: chId });
      },
      onChapterFailed: (e: { chapterId: number; message: string }) => failed.push(e),
    });
    const { appliable, unappliable } = planApply(allOps, sentences, characterIds) as {
      appliable: ReviewOpWithChapter[];
      unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
    };
    if (appliable.length === 0 && unappliable.length === 0 && failed.length > 0) {
      dispatch(
        notificationsActions.pushToast({
          kind: 'warn',
          message: failed.length === 1 ? failed[0].message : `${failed.length} chapters couldn't be reviewed (too large or failed).`,
        }),
      );
    } else {
      if (failed.length > 0) {
        dispatch(notificationsActions.pushToast({ kind: 'warn', message: `${failed.length} chapter(s) skipped; showing the rest.` }));
      }
      dispatch(scriptReviewActions.setReview({ bookId, ops: appliable, unappliable }));
    }
  } catch (err) {
    dispatch(
      notificationsActions.pushToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Script review failed.',
      }),
    );
  } finally {
    dispatch(scriptReviewActions.clear({ bookId }));
  }
}
```

(Progress is the server's own 0..1 `onPhase` value — monotonic and reaching ~1.0 before the stream's terminal `result` event, so the pill doesn't stall mid-bar. `setReview` is dispatched from the collected `allOps` after the stream ends, unchanged.)

- [ ] **Step 4: Delegate from `manuscript.tsx`**

Replace the body of `handleReviewScript` (`manuscript.tsx:697-758`) with a thin delegate:

```ts
  async function handleReviewScript(wholeBook: boolean) {
    if (!bookId || reviewLoading) return;
    if (!wholeBook && currentChapterId == null) return;
    setReviewLoading(true);
    setReviewMenuOpen(false);
    try {
      await runReviewScript(bookId, {
        dispatch,
        wholeBook,
        chapterId: wholeBook ? undefined : currentChapterId ?? undefined,
        model: reviewModel,
        sentences: sentencesRef.current.map((s) => ({
          id: s.id,
          chapterId: s.chapterId,
          text: s.text,
          characterId: s.characterId,
          instruct: s.instruct,
          vocalization: s.vocalization,
        })),
        characterIds: new Set(characters.map((c) => c.id)),
      });
    } finally {
      setReviewLoading(false);
    }
  }
```

Add the import: `import { runReviewScript } from '../store/script-review-thunk';`. Remove now-unused imports in `manuscript.tsx` that the lifted code orphaned (e.g. `planApply` if nothing else uses it — verify with a grep before deleting).

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test -- src/store/script-review-thunk.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store/script-review-thunk.ts src/store/script-review-thunk.test.ts src/views/manuscript.tsx
git commit -m "feat(frontend): extract runReviewScript thunk that drives the review pill"
```

---

### Task 6: Pass mutual-exclusion (both analysis buttons gate per book)

**Files:**
- Modify: `src/components/detect-emotions-button.tsx` (disable when busy)
- Modify: `src/views/manuscript.tsx` (the three Review buttons disable when busy)
- Test: `src/components/detect-emotions-button.test.tsx`, a manuscript review-button test

**Interfaces:**
- Consumes: `selectAnalysisBusyForBook` (Task 3).

- [ ] **Step 1: Write the failing tests**

In `detect-emotions-button.test.tsx`, add a concrete test using the `makeStore()` (now wired with `scriptReview` from Task 4). Set a review active for `b1`, then assert the Detect-emotions trigger is disabled:

```ts
import { scriptReviewActions } from '../store/script-review-slice';

it('disables Detect emotions while a review runs on the same book', () => {
  const store = makeStore(); // ui.stage.bookId === 'b1'
  store.dispatch(scriptReviewActions.setActive({ bookId: 'b1', progress: 0.05, label: 'Reviewing' }));
  render(
    <Provider store={store}>
      <DetectEmotionsButton />
    </Provider>,
  );
  expect(screen.getByTestId('detect-emotions-button')).toBeDisabled();
});
```

The symmetric direction — the three Review buttons disabled while a prosody pass runs — is covered by the e2e in Task 10 (`generate-disabled-while-analysing.spec.ts` extends to assert `review-script-chapter` is disabled mid-prosody), because a focused unit render of the full `manuscript.tsx` view is disproportionately heavy for this one-line `disabled` wiring.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- detect-emotions-button.test.tsx`
Expected: FAIL — button enabled.

- [ ] **Step 3: Implement**

In `detect-emotions-button.tsx`, read the busy flag and fold it into the rendered button's `disabled`:

```ts
const busy = useAppSelector((s) => (bookId ? selectAnalysisBusyForBook(s, bookId) : false));
```

In the idle-render `<button>`, change `disabled={disabled}` to `disabled={disabled || busy}`. Import `selectAnalysisBusyForBook`.

In `manuscript.tsx`, near the existing `reviewLoading` state, add:

```ts
const analysisBusy = useAppSelector((s) => (bookId ? selectAnalysisBusyForBook(s, bookId) : false));
```

Change each of the three Review buttons' `disabled={reviewLoading || !bookId}` (lines 827/835/850) to `disabled={reviewLoading || !bookId || analysisBusy}`. Import the selector.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -- detect-emotions-button.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/detect-emotions-button.tsx src/components/detect-emotions-button.test.tsx src/views/manuscript.tsx
git commit -m "feat(frontend): make the two analysis passes mutually exclusive per book"
```

---

### Task 7: `shouldAutoTriggerProsody` + auto-trigger guard

**Files:**
- Create: `src/store/should-auto-trigger-prosody.ts`
- Modify: `src/components/layout.tsx` (auto-trigger effect calls it)
- Test: `src/store/should-auto-trigger-prosody.test.ts`, `src/store/prosody-autotrigger.test.tsx` (update)

**Interfaces:**
- Consumes: `selectAnalysisBusyForBook` (Task 3).
- Produces: `shouldAutoTriggerProsody(state: RootState, bookId: string): boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/store/should-auto-trigger-prosody.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { shouldAutoTriggerProsody } from './should-auto-trigger-prosody';
import type { RootState } from './index';

const mk = (prosody = {}, review = {}) =>
  ({ prosody: { activeStreams: prosody }, scriptReview: { activeStreams: review } } as unknown as RootState);

describe('shouldAutoTriggerProsody', () => {
  it('true when idle', () => expect(shouldAutoTriggerProsody(mk(), 'b1')).toBe(true));
  it('false when prosody runs for the book', () =>
    expect(shouldAutoTriggerProsody(mk({ b1: { progress: 0, label: 'x' } }), 'b1')).toBe(false));
  it('false when review runs for the book', () =>
    expect(shouldAutoTriggerProsody(mk({}, { b1: { progress: 0, label: 'x' } }), 'b1')).toBe(false));
  it('true when another book is busy', () =>
    expect(shouldAutoTriggerProsody(mk({ b2: { progress: 0, label: 'x' } }), 'b1')).toBe(true));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/store/should-auto-trigger-prosody.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/store/should-auto-trigger-prosody.ts`:

```ts
import type { RootState } from './index';
import { selectAnalysisBusyForBook } from './analysis-substage-selectors';

/** Pure in-memory gate for the fs-65 auto-trigger: don't fire while any
    analysis sub-stage is already running for this book (manual button or a
    cross-tab broadcast). The disk `prosodyAnnotated` watermark remains the
    separate "already done" gate, checked async in the effect. */
export function shouldAutoTriggerProsody(state: RootState, bookId: string): boolean {
  return !selectAnalysisBusyForBook(state, bookId);
}
```

- [ ] **Step 4: Wire it into the auto-trigger effect**

In `src/components/layout.tsx`, inside the detached async job (after `prosodyConsidered.current.add(id)`, before/after the `api.getBookState` gate), add the in-memory guard. Use the store's `getState` (Layout has `store` via `useStore`, or read through a ref). Simplest: read via the `useStore()` hook already available, or capture a `store` reference. Add at the top of the async body:

```ts
        if (!shouldAutoTriggerProsody(store.getState(), id)) return; // already running here / cross-tab
```

(If `store` isn't in scope, add `const store = useStore<RootState>();` near the other hooks and `import { useStore } from 'react-redux';`.) Import `shouldAutoTriggerProsody`.

Also make the auto-trigger's clear finally-safe — wrap the existing try/catch so `clear({ bookId: id })` runs once on all paths:

```ts
        let pillActive = false;
        try {
          const st = await api.getBookState(id);
          if (!st || st.state.prosodyEnabled === false) return;
          if (st.state.prosodyAnnotated) return;
          dispatch(prosodyActions.setActive({ bookId: id, progress: 0, label: 'Detecting emotions' }));
          pillActive = true;
          const { failed } = await runProsodyPasses(id, {
            dispatch,
            onProgress: (f) => dispatch(prosodyActions.updateProgress({ bookId: id, progress: f })),
          });
          if (failed === 0) {
            await api.putBookState(id, { slice: 'state', patch: { prosodyAnnotated: true } });
          } else {
            prosodyConsidered.current.delete(id);
          }
        } catch {
          prosodyConsidered.current.delete(id);
        } finally {
          if (pillActive) dispatch(prosodyActions.clear({ bookId: id }));
        }
```

- [ ] **Step 5: Update the auto-trigger integration test**

In `src/store/prosody-autotrigger.test.tsx`, add a case: when `prosody.activeStreams[bookId]` is already set before the complete-transition fires, `runProsodyPasses` is NOT called again for that book. (Mock `runProsodyPasses`; pre-seed the store; assert call count stays 0.)

- [ ] **Step 6: Run to verify**

Run: `npm run test -- src/store/should-auto-trigger-prosody.test.ts src/store/prosody-autotrigger.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/store/should-auto-trigger-prosody.ts src/store/should-auto-trigger-prosody.test.ts src/store/prosody-autotrigger.test.tsx src/components/layout.tsx
git commit -m "feat(frontend): guard the prosody auto-trigger against double-fire"
```

---

### Task 8: Generate-gate (UI disable + enqueue thunk filter)

**Files:**
- Modify: `src/views/generation.tsx` (disable Generate/regenerate for a busy book)
- Modify: `src/store/queue-thunks.ts` (`enqueueQueueEntries` filters gated entries)
- Test: `src/store/queue-thunks.test.ts` (guard), e2e in Task 9

**Interfaces:**
- Consumes: `selectAnalysisBusyForBook` (Task 3).

- [ ] **Step 1: Write the failing thunk test**

In `src/store/queue-thunks.test.ts` (create if absent), add: `enqueueQueueEntries` drops entries whose book is busy and toasts, enqueuing only the rest.

Mock the network seam this file already uses (check the top of `queue-thunks.ts` for whether `queueRequest`/`readSnapshot` are module-locals or imported; if locals, mock `fetch`). Concrete test capturing the POST body:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enqueueQueueEntries } from './queue-thunks';
import { scriptReviewActions } from './script-review-slice';

const posted: unknown[] = [];
beforeEach(() => { posted.length = 0; });
// Stub global fetch to capture the enqueue body and return a snapshot echoing it.
vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body) as { entries: unknown[] };
  posted.push(...body.entries);
  return { ok: true, json: async () => ({ entries: body.entries, paused: false, recycling: false, loaded: true }) } as Response;
}));

it('enqueues only un-gated entries and toasts the gated pass', async () => {
  const dispatch = vi.fn();
  const getState = () => ({
    prosody: { activeStreams: { b1: { progress: 0, label: 'Detecting emotions' } } },
    scriptReview: { activeStreams: {} },
  }) as never;
  await enqueueQueueEntries([
    { id: 'e1', bookId: 'b1', chapterId: 1, scope: 'this' },
    { id: 'e2', bookId: 'b2', chapterId: 1, scope: 'this' },
  ])(dispatch as never, getState as never);
  // Only the un-gated b2 entry was POSTed:
  expect(posted).toEqual([{ id: 'e2', bookId: 'b2', chapterId: 1, scope: 'this' }]);
  // A warn toast with the per-pass (prosody) copy fired:
  const toasts = dispatch.mock.calls.map((c) => c[0]).filter((a) => a.type?.includes('pushToast'));
  expect(toasts.some((t) => t.payload.message === 'Wait — emotions are still being detected')).toBe(true);
});
```

(If `queue-thunks.ts` wraps `fetch` in a `queueRequest` helper that sets a base URL/headers, the global-`fetch` stub still intercepts it; adjust the returned shape to match `readSnapshot`'s expectations — read those two helpers first.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/store/queue-thunks.test.ts`
Expected: FAIL — guard not present / `getState` unused.

- [ ] **Step 3: Implement the thunk guard**

In `src/store/queue-thunks.ts`, give `enqueueQueueEntries` access to `getState` and filter:

```ts
import type { RootState } from './index';
import { selectAnalysisBusyForBook, analysisBusyMessage } from './analysis-substage-selectors';

export function enqueueQueueEntries(entries: EnqueueInput[], opts: { silent?: boolean } = {}) {
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<QueueSnapshotResponse> => {
    const state = getState();
    const allowed = entries.filter((e) => !selectAnalysisBusyForBook(state, e.bookId));
    const gated = entries.filter((e) => selectAnalysisBusyForBook(state, e.bookId));
    if (gated.length > 0) {
      dispatch(
        notificationsActions.pushToast({
          kind: 'warn',
          message: analysisBusyMessage(state, gated[0].bookId) ?? 'Wait — analysis is still running on this book.',
          dedupeKey: 'gen-gated-by-analysis',
        }),
      );
    }
    /* If every entry was gated, return without a network call — see the
       VERIFY note below for why we don't POST an empty array. */
    if (allowed.length === 0) return snapshotFromState(getState());
    const res = await queueRequest('/api/queue/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: allowed }),
    });
    const snapshot = await readSnapshot(res);
    dispatch(queueActions.setSnapshot(snapshot));
    if (!opts.silent) {
      dispatch(
        notificationsActions.pushToast({
          kind: 'info',
          message: `Added to queue · ${allowed.length} ${allowed.length === 1 ? 'entry' : 'entries'} pending.`,
          dedupeKey: 'queue-enqueue',
        }),
      );
    }
    return snapshot;
  };
}
```

> **VERIFY before implementing (finding R2):** the original code never POSTed an empty `entries` array, so don't assume `/api/queue/enqueue` treats `[]` as a no-op — read `server/.../queue` route handler first. Two correct shapes, pick by what the route does:
> 1. **All-gated early-return (shown above, preferred):** when `allowed.length === 0`, return the current snapshot *without* a network call. Implement `snapshotFromState` by mapping the `queue` slice to the `QueueSnapshotResponse` shape (read `readSnapshot`'s return type + the `queue-slice` `QueueState` to confirm the fields line up — they're the same `entries/paused/recycling/loaded` shape today, so it's a structural copy, **not** an `as unknown as` cast). If the shapes have diverged, instead narrow this function's return type to `Promise<QueueSnapshotResponse | null>` and `return null` (all current callers `void` the result — grep to confirm before relying on this).
> 2. **Only if the route is confirmed to no-op on `[]`:** delete the early-return and always POST `allowed`; the typed snapshot then always comes from `readSnapshot`.

(Import `RootState` from `./index`.)

- [ ] **Step 4: Disable the Generate UI**

In `src/views/generation.tsx`, read the busy flag near the top of the component:

```ts
const analysisBusy = useAppSelector((s) => (bookId ? selectAnalysisBusyForBook(s, bookId) : false));
```

Guard `handleGenerateChapter` and disable the primary Generate / bulk-regenerate buttons. At minimum, early-return + toast inside `handleGenerateChapter`:

```ts
  function handleGenerateChapter(ch: Chapter): void {
    if (analysisBusy) {
      const msg = analysisBusyMessage(store.getState(), bookId) ?? 'Wait — analysis is still running on this book.';
      dispatch(notificationsActions.pushToast({ kind: 'warn', message: msg, dedupeKey: 'gen-gated-by-analysis' }));
      return;
    }
    // …existing body…
  }
```

(`analysisBusyMessage` needs the live state; read it via the `useStore()` hook (`const store = useStore<RootState>()`) so the message reflects which pass is running. The enqueue thunk guard (Step 3) is the real backstop — this UI early-return is just immediate feedback.)

And add `disabled={analysisBusy || …}` to the rendered Generate / "Generate all" / RegenerateModal-confirm buttons (grep `enqueueQueueEntries`/`onRegenerate`/`Generate` within `generation.tsx` for the button sites). Import `selectAnalysisBusyForBook` + `analysisBusyMessage` + `notificationsActions`.

- [ ] **Step 5: Run to verify**

Run: `npm run test -- src/store/queue-thunks.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store/queue-thunks.ts src/store/queue-thunks.test.ts src/views/generation.tsx
git commit -m "feat(frontend): gate Generate while a book's analysis sub-stage runs"
```

---

### Task 9: Cross-tab broadcast (`sync:substage`)

**Files:**
- Modify: `src/store/broadcast-middleware.ts`
- Test: `src/store/broadcast-middleware.test.ts`

**Interfaces:**
- Consumes: `prosodyActions.applyExternalSet/applyExternalClear`, `scriptReviewActions.applyExternalSet/applyExternalClear`, `SubstageEntry`.

- [ ] **Step 1: Write the failing test**

In `src/store/broadcast-middleware.test.ts`, add a self-contained harness that injects a fake channel into `createBroadcastMiddleware` (the factory sets `channel.onmessage` to the inbound handler, so the test can both read `posted` and fire inbound messages):

```ts
import { describe, it, expect } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { createBroadcastMiddleware, type BroadcastMessage } from './broadcast-middleware';
import { prosodySlice, prosodyActions } from './prosody-slice';
import { scriptReviewSlice } from './script-review-slice';

function harness(instanceId = 'self') {
  const posted: BroadcastMessage[] = [];
  const channel = {
    postMessage: (m: BroadcastMessage) => posted.push(m),
    onmessage: null as null | ((e: { data: BroadcastMessage }) => void),
    close: () => {},
  } as unknown as BroadcastChannel;
  const store = configureStore({
    reducer: { prosody: prosodySlice.reducer, scriptReview: scriptReviewSlice.reducer },
    middleware: (gdm) => gdm({ serializableCheck: false }).concat(createBroadcastMiddleware({ channel, instanceId })),
  });
  const inbound = (m: BroadcastMessage) => channel.onmessage!({ data: m });
  return { store, posted, inbound };
}

describe('broadcast-middleware sync:substage', () => {
  it('posts set on setActive and clear on clear (book taken from payload)', () => {
    const { store, posted } = harness();
    store.dispatch(prosodyActions.setActive({ bookId: 'b1', progress: 0.4, label: 'Detecting emotions' }));
    expect(posted.at(-1)).toMatchObject({ kind: 'sync:substage', stream: 'prosody', bookId: 'b1', mode: 'set', entry: { progress: 40, label: 'Detecting emotions' } });
    store.dispatch(prosodyActions.clear({ bookId: 'b1' }));
    expect(posted.at(-1)).toMatchObject({ kind: 'sync:substage', stream: 'prosody', bookId: 'b1', mode: 'clear' });
  });

  it('applies a foreign inbound set and does NOT re-broadcast', () => {
    const { store, posted, inbound } = harness('self');
    inbound({ kind: 'sync:substage', instanceId: 'other', stream: 'prosody', bookId: 'bX', mode: 'set', entry: { progress: 22, label: 'Detecting emotions' } });
    expect(store.getState().prosody.activeStreams.bX).toEqual({ progress: 22, label: 'Detecting emotions' });
    expect(posted).toHaveLength(0); // applyExternalSet is not in the outbound match set
  });

  it('drops self-echo by instanceId', () => {
    const { store, inbound } = harness('self');
    inbound({ kind: 'sync:substage', instanceId: 'self', stream: 'prosody', bookId: 'bSelf', mode: 'set', entry: { progress: 5, label: 'x' } });
    expect(store.getState().prosody.activeStreams.bSelf).toBeUndefined();
  });

  it('a clear on book X leaves book Y intact (finding-2 regression)', () => {
    const { store, inbound } = harness('self');
    inbound({ kind: 'sync:substage', instanceId: 'other', stream: 'prosody', bookId: 'b1', mode: 'set', entry: { progress: 1, label: 'x' } });
    inbound({ kind: 'sync:substage', instanceId: 'other', stream: 'prosody', bookId: 'b2', mode: 'set', entry: { progress: 2, label: 'y' } });
    inbound({ kind: 'sync:substage', instanceId: 'other', stream: 'prosody', bookId: 'b1', mode: 'clear' });
    expect(store.getState().prosody.activeStreams.b1).toBeUndefined();
    expect(store.getState().prosody.activeStreams.b2).toEqual({ progress: 2, label: 'y' });
  });
});
```

(`scriptReviewSlice` is imported so the minimal store has both reducers the middleware's substage branch reads; the analysis/chapters branches aren't exercised here, so those slices can be omitted.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/store/broadcast-middleware.test.ts`
Expected: FAIL — no `sync:substage` handling.

- [ ] **Step 3: Implement**

In `src/store/broadcast-middleware.ts`:

Add imports:

```ts
import { prosodyActions } from './prosody-slice';
import { scriptReviewActions, } from './script-review-slice';
import type { SubstageEntry } from './prosody-slice';
```

Extend the `BroadcastMessage` union with:

```ts
  | {
      kind: 'sync:substage';
      instanceId: string;
      stream: 'prosody' | 'review';
      bookId: string;
      mode: 'set';
      entry: SubstageEntry;
    }
  | {
      kind: 'sync:substage';
      instanceId: string;
      stream: 'prosody' | 'review';
      bookId: string;
      mode: 'clear';
    };
```

Add the outbound match sets (do NOT include the `applyExternal*` actions — echo layer 2):

```ts
const SUBSTAGE_BROADCAST_ACTIONS: ReadonlySet<string> = new Set([
  'prosody/setActive', 'prosody/updateProgress', 'prosody/clear',
  'scriptReview/setActive', 'scriptReview/updateProgress', 'scriptReview/clear',
]);
```

In the inbound `channel.onmessage` handler (after the existing `sync:analysis` / `sync:chapters` branches, with the `instanceId === self` drop already at the top), add:

```ts
        if (msg.kind === 'sync:substage') {
          const actions = msg.stream === 'prosody' ? prosodyActions : scriptReviewActions;
          if (msg.mode === 'clear') {
            store.dispatch(actions.applyExternalClear({ bookId: msg.bookId }));
          } else {
            store.dispatch(actions.applyExternalSet({ bookId: msg.bookId, entry: msg.entry }));
          }
          return;
        }
```

In the outbound middleware return (after the `CHAPTERS_BROADCAST_ACTIONS` block, before `return result`), add:

```ts
      if (SUBSTAGE_BROADCAST_ACTIONS.has(type)) {
        const [sliceName] = type.split('/');
        const stream: 'prosody' | 'review' = sliceName === 'prosody' ? 'prosody' : 'review';
        const bookId = (a.payload as { bookId?: string })?.bookId;
        if (!bookId) return result;
        const state = store.getState() as unknown as {
          prosody: { activeStreams: Record<string, SubstageEntry> };
          scriptReview: { activeStreams: Record<string, SubstageEntry> };
        };
        const map = stream === 'prosody' ? state.prosody.activeStreams : state.scriptReview.activeStreams;
        const entry = map[bookId]; // present for set/updateProgress; absent after clear
        if (entry) {
          send({ kind: 'sync:substage', instanceId, stream, bookId, mode: 'set', entry });
        } else {
          send({ kind: 'sync:substage', instanceId, stream, bookId, mode: 'clear' });
        }
        return result;
      }
```

(Note: the cleared book is taken from `action.payload.bookId`, not post-state — finding 9.)

**Debounce decision (finding 7):** v1 ships **without** a progress-tick debounce on `sync:substage`. Rationale: prosody `onProgress` is chapter-granular (emotions 0–50%, instruct 50–100% over the chapter list) and review progress is one tick per chapter — both far coarser than the analyzer phase ticks the existing `PROGRESS_DEBOUNCE_MS` path was built for (which fire ~10×/sec). A handful of cross-tab messages per book-pass is negligible. **Log this in the regression plan** (Task 11) as a deliberate omission, not an oversight; if a future engine emits sub-second prosody ticks, add a `(stream, bookId)`-keyed debounce mirroring the analysis block.

Update the `BroadcastableRootState` interface to include the two substage maps if the outbound block reads them through it.

- [ ] **Step 4: Run to verify**

Run: `npm run test -- src/store/broadcast-middleware.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/broadcast-middleware.ts src/store/broadcast-middleware.test.ts
git commit -m "feat(frontend): sync analysis sub-stage progress cross-tab via sync:substage"
```

---

### Task 10: E2E specs + mock cadence

**Files:**
- Create: `e2e/detect-emotions-pill-progress.spec.ts`, `e2e/script-review-pill-progress.spec.ts`, `e2e/prosody-auto-trigger-guard.spec.ts`, `e2e/generate-disabled-while-analysing.spec.ts`
- Modify: the mock for `reviewScript` (`src/mocks/*` — find `mockReviewScript`) for a predictable progress cadence

**Interfaces:** consumes the UI testids: `status-pill`, `substage-row`, `detect-emotions-progress`, `review-script-chapter`, `review-script-wholebook`.

- [ ] **Step 1: Extend the review mock cadence**

Find the mock backing `api.reviewScript` (it's `mockReviewScript` — `api.ts:3050`). It already emits one `onPhase({ progress: 0.5, ... })`; add a couple more `onPhase` ticks (e.g. `0.25`, `0.5`, `0.85`) with a fixed `await wait(...)` between them before the existing `onOps` calls, so the "Reviewing" pill is observably mid-progress in e2e (progress is read from `onPhase`, per Task 5). Deterministic delays only (no randomness — see the project's e2e-flake notes).

- [ ] **Step 2: Write `e2e/detect-emotions-pill-progress.spec.ts`**

```ts
import { test, expect } from '@playwright/test';

test('manual Detect emotions surfaces on the Status pill and survives navigation', async ({ page }) => {
  await page.goto('/'); // mock mode; open a book → manuscript view (reuse existing nav helpers/fixtures)
  // click Detect emotions → confirm
  await expect(page.getByTestId('status-pill')).toContainText('Analysing');
  // navigate to Listen, assert the pill is still present/updating, navigate back, assert completion toast
});
```

- [ ] **Step 3: Write `e2e/script-review-pill-progress.spec.ts`**

Whole-book review → `status-pill` shows "Analysing" → navigate away → pill persists → toast + diff modal on completion.

- [ ] **Step 4: Write `e2e/prosody-auto-trigger-guard.spec.ts`**

Pre-seed/drive an active prosody stream for a book, then trigger the auto-trigger condition, and assert `runProsodyPasses` doesn't double-run (assert single "Analysing" pill / single completion toast, no duplicate annotations).

- [ ] **Step 5: Write `e2e/generate-disabled-while-analysing.spec.ts`**

While a sub-stage runs on book X: (a) the Generate control on the Generate view is `disabled`; (b) on the Manuscript view the `review-script-chapter` button is `disabled` too (the pass mutual-exclusion from Task 6 — this is the e2e that covers the Manuscript-side wiring, per Task 6 Step 1); (c) clicking a still-enabled Generate path surfaces the warn toast with the per-pass copy. Reuse the book-open/nav helper from `e2e/script-review.spec.ts`; drive the sub-stage by clicking `detect-emotions-button` → `detect-emotions-confirm` (the mock keeps it running long enough to assert).

- [ ] **Step 6: Run the new e2e specs**

Run: `npm run test:e2e -- e2e/detect-emotions-pill-progress.spec.ts e2e/script-review-pill-progress.spec.ts e2e/prosody-auto-trigger-guard.spec.ts e2e/generate-disabled-while-analysing.spec.ts`
Expected: PASS. (If a spec passes alone but flakes in the battery, wrap its `describe` in `{ mode: 'serial' }` per the project's known parallel-worker state-race note.)

- [ ] **Step 7: Commit**

```bash
git add e2e/detect-emotions-pill-progress.spec.ts e2e/script-review-pill-progress.spec.ts e2e/prosody-auto-trigger-guard.spec.ts e2e/generate-disabled-while-analysing.spec.ts src/mocks
git commit -m "test(frontend): e2e for analysis pill progress + Generate-gate"
```

---

### Task 11: Regression doc, INDEX, ship

**Files:**
- Create: `docs/features/<id>-manuscript-analysis-pill-gate.md` (from `docs/features/TEMPLATE.md`) OR extend the fs-65 plan
- Modify: `docs/features/INDEX.md`
- File a Backlog-item GitHub issue and add its thin row to `docs/BACKLOG.md`

- [ ] **Step 1: Write the regression plan** documenting the invariants: per-book maps; Generate-gate + pass mutual-exclusion via `selectAnalysisBusyForBook`; auto-trigger guard via `shouldAutoTriggerProsody` (+ disk watermark); cross-tab `sync:substage`; the accepted limitations (mid-run tab open, TOCTOU, %-discontinuity). Link the spec.

- [ ] **Step 2: Add the INDEX entry** under the relevant area.

- [ ] **Step 3: Run the full battery**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build all green (cache-aware).

- [ ] **Step 4: Commit + open the PR**

```bash
git add docs/features docs/BACKLOG.md
git commit -m "docs(docs): regression plan + backlog row for analysis pill gate"
git push -u origin feat/frontend-analysis-pill-gate
gh pr create --title "feat(frontend): manuscript analysis pill feedback + Generate-gate" --body "..."
```

PR body: enumerate every user/operator/dev-visible delta (pill rung, retired prosody pill, Generate-gate, pass exclusion, auto-trigger guard, cross-tab sync), link the spec + regression plan, and `Closes #NN` for the backlog issue.

---

## Self-Review

- **Spec coverage:** §1 state model → Tasks 1, 2, 3 (selectors), 9 (broadcast); §2 progress wiring + pill → Tasks 3, 4, 5; pass mutual-exclusion → Task 6; §3 Generate-gate → Task 8; §4 auto-trigger guard → Task 7; toasts → Tasks 4/5/8; tests → every task + Task 10; shipping → Task 11. All 14 adversarial findings map to code: 8/9 → Task 9; 2 → Tasks 1/2 + Task 9 regression test; 3 → Tasks 4/5/7 (`finally`); 4 → Task 3 (e2e re-point + delete); 10 → Task 6; 11 → Task 3 (`createSelector`); 12 → Task 7; 13 → Task 9 (echo layer 1); 14 → Task 1.
- **Type consistency:** `SubstageEntry` defined in Task 1, imported by Tasks 2/3/9; `selectAnalysisBusyForBook` + `analysisBusyMessage` defined in Task 3, consumed by Tasks 6/7/8; `runReviewScript` signature (incl. `totalChapters`) fixed in Task 5 and matched by the Task 5 delegate; `analysisSubstage` shapes are intentionally distinct per consumer and consistent with what Layout passes — `StatusInput` gets `{ kind, percent }` (rung needs only percent), `StatusDetail` gets `{ label, percent }` (popover renders the label), and the selector returns `{ kind, label, percent }` (superset).
- **Round-2 fixes folded:** P1 (Task 1 migrates `layout-prosody-pill.test.tsx` in-commit), P2 (review progress wired from a real callback), P3 (concrete test code in Tasks 4/6/8/9; e2e reference the real nav helpers + testids), P4 (`analysisSubstage` optional), P5 (no unsafe cast), P6 (per-pass copy via `analysisBusyMessage`), P7 (debounce omission is a logged decision), P8 (popover uses the selector's `label`).
- **Round-3 fixes folded:** R1 (review progress comes from `onPhase`'s real 0..1 value, **not** an `onOps` count that would stall on empty chapters — `totalChapters` removed), R2 (the all-gated path early-returns a typed snapshot, with a VERIFY note on the queue route instead of an unverified empty-POST), R3 (`vi.mocked` not `as unknown as vi.Mock`), R4 (migrate-then-delete of the pill test is a logged deliberate choice), R5 (grep `getInitialState` assertion before widening `script-review-slice` state).
- **Known residual ambiguities** (flagged inline, not placeholders): exact button sites in `generation.tsx` (grep-located in Task 8); whether `api.reviewScript` exposes an `onProgress` (Task 5 ships indeterminate "Reviewing · 0%" until the mock/real API emits ticks — Task 10 mock adds cadence); `enqueueQueueEntries` early-return response shape (Task 8 returns the current queue snapshot).
